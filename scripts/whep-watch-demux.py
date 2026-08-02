#!/usr/bin/env python3
"""Streamplace WHEP → eve watch raw pipes (RGBA tile + f32le mono PCM).

stream.place watch is WHEP-only — do not add HLS fallback here. If this demux
is flaky, fix WHEP (deps, SDP, rendition, ICE). Emit WHEP_READY on stderr after
a successful WHEP answer so eve-av-bridge can fail play instead of zombie-ok.

Drop-to-live + frame-aligned fifo:
  - Decode continuously; keep only the newest VideoFrame.
  - Letterbox/scale ONLY the latest frame when writing.
  - Always write a FULL RGBA tile (640x360x4=921600 bytes; never short writes).
    Short writes into a 64KiB pipe desync the reader and look like a
    scrolling 'wave' tear across the picture.
"""
from __future__ import annotations

import argparse
import asyncio
import fcntl
import logging
import os
import signal
import sys
from typing import Optional
from urllib.parse import parse_qs, urljoin, urlparse

LOG = logging.getLogger("whep-demux")

try:
    import aiohttp
    import av
    import numpy as np
    from aiortc import RTCConfiguration, RTCPeerConnection, RTCSessionDescription
    from av.audio.resampler import AudioResampler
except ImportError as e:
    sys.stderr.write(
        "WHEP_DEPS_MISSING: %s\n"
        "Install with: bash scripts/install-whep-deps.sh "
        "(nix build .#whep-python, or pip --target fallback)\n" % e
    )
    raise SystemExit(2) from e

WATCH_W = 640
WATCH_H = 360
SPEAK_RATE = 48_000
FRAME_BYTES = WATCH_W * WATCH_H * 4


def letterbox_rgba(frame: av.VideoFrame, tw: int, th: int) -> bytes:
    src = frame.reformat(format="rgba")
    arr = src.to_ndarray()
    h, w = arr.shape[:2]
    if w <= 0 or h <= 0:
        return bytes(tw * th * 4)
    scale = min(tw / w, th / h)
    nw = max(1, int(round(w * scale)))
    nh = max(1, int(round(h * scale)))
    scaled = src.reformat(width=nw, height=nh, format="rgba").to_ndarray()
    out = np.zeros((th, tw, 4), dtype=np.uint8)
    x0 = (tw - nw) // 2
    y0 = (th - nh) // 2
    out[y0 : y0 + nh, x0 : x0 + nw] = scaled
    return out.tobytes()


async def recv_frame(track, stop: asyncio.Event):
    while not stop.is_set():
        task = asyncio.create_task(track.recv())
        stop_task = asyncio.create_task(stop.wait())
        done, _pending = await asyncio.wait(
            {task, stop_task}, return_when=asyncio.FIRST_COMPLETED
        )
        if stop_task in done:
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
            return None
        stop_task.cancel()
        try:
            return task.result()
        except Exception as e:
            LOG.warning("%s recv error: %s", track.kind, e)
            return None
    return None


async def video_consumer(track, latest: dict, stop: asyncio.Event) -> None:
    frames = 0
    dropped = 0
    while not stop.is_set():
        frame = await recv_frame(track, stop)
        if frame is None:
            break
        if latest.get("frame") is not None:
            dropped += 1
        latest["frame"] = frame
        latest["seq"] = latest.get("seq", 0) + 1
        frames += 1
        if frames == 1 or frames % 300 == 0:
            LOG.info(
                "video decoded=%s dropped_pre_convert=%s last=%sx%s",
                frames,
                dropped,
                getattr(frame, "width", "?"),
                getattr(frame, "height", "?"),
            )
    try:
        await track.stop()
    except Exception:
        pass


def _enlarge_pipe(fd: int, want: int = min(max(FRAME_BYTES, 512 * 1024), 1024 * 1024)) -> None:
    F_SETPIPE_SZ = getattr(fcntl, "F_SETPIPE_SZ", 1031)
    F_GETPIPE_SZ = getattr(fcntl, "F_GETPIPE_SZ", 1032)
    try:
        fcntl.fcntl(fd, F_SETPIPE_SZ, want)
    except OSError as e:
        LOG.warning("F_SETPIPE_SZ %s failed: %s", want, e)
    try:
        LOG.info("pipe_sz=%s frame=%s", fcntl.fcntl(fd, F_GETPIPE_SZ), FRAME_BYTES)
    except OSError:
        pass


def _write_full(fd: int, blob: bytes) -> None:
    view = memoryview(blob)
    while view:
        n = os.write(fd, view)
        if n <= 0:
            raise OSError("fifo write returned %s" % n)
        view = view[n:]


async def video_fifo_writer(fifo_path: str, latest: dict, stop: asyncio.Event) -> None:
    LOG.info("waiting for video fifo reader on %s", fifo_path)
    fd = None
    while not stop.is_set():
        try:
            fd = await asyncio.to_thread(os.open, fifo_path, os.O_WRONLY)
            _enlarge_pipe(fd)
            break
        except OSError as e:
            LOG.warning("video fifo open: %s; retry", e)
            await asyncio.sleep(0.2)
    if fd is None:
        return
    LOG.info("video fifo open (atomic full-frame writes)")
    last_seq = -1
    written = 0
    skipped = 0
    try:
        while not stop.is_set():
            seq = latest.get("seq", 0)
            frame = latest.get("frame")
            if frame is None or seq == last_seq:
                await asyncio.sleep(0.002)
                continue
            seq = latest.get("seq", seq)
            frame = latest.get("frame")
            last_seq = seq
            try:
                blob = await asyncio.to_thread(letterbox_rgba, frame, WATCH_W, WATCH_H)
            except Exception as e:
                LOG.warning("video convert: %s", e)
                continue
            if latest.get("seq", 0) != seq:
                skipped += 1
                continue
            try:
                await asyncio.to_thread(_write_full, fd, blob)
                written += 1
                if written == 1 or written % 150 == 0:
                    LOG.info("video fifo written=%s skipped=%s", written, skipped)
            except BrokenPipeError:
                LOG.info("video fifo reader gone")
                break
            except OSError as e:
                LOG.warning("video fifo write: %s", e)
                break
    finally:
        try:
            os.close(fd)
        except OSError:
            pass


async def audio_consumer(track, stop: asyncio.Event) -> None:
    resampler = AudioResampler(format="flt", layout="mono", rate=SPEAK_RATE)
    out = sys.stdout.buffer
    try:
        flags = fcntl.fcntl(1, fcntl.F_GETFL)
        fcntl.fcntl(1, fcntl.F_SETFL, flags | os.O_NONBLOCK)
    except OSError:
        pass
    samples = 0
    drops = 0
    pending = bytearray()
    while not stop.is_set():
        frame = await recv_frame(track, stop)
        if frame is None:
            break
        try:
            for rf in resampler.resample(frame):
                arr = rf.to_ndarray()
                if arr.ndim == 2:
                    mono = arr[0] if arr.shape[0] <= 8 else arr.mean(axis=1)
                else:
                    mono = arr
                pcm = np.ascontiguousarray(mono, dtype=np.float32)
                pending.extend(pcm.tobytes())
            max_pending = int(SPEAK_RATE * 0.1) * 4
            if len(pending) > max_pending:
                drops += (len(pending) - max_pending) // 4
                del pending[:-max_pending]
            while pending:
                try:
                    n = out.write(pending)
                    if not n:
                        drops += len(pending) // 4
                        pending.clear()
                        break
                    del pending[:n]
                    samples += n // 4
                    if pending:
                        drops += len(pending) // 4
                        pending.clear()
                        break
                except BlockingIOError:
                    drops += len(pending) // 4
                    pending.clear()
                    break
            try:
                out.flush()
            except Exception:
                pass
        except BrokenPipeError:
            LOG.info("audio stdout reader gone")
            break
        except Exception as e:
            LOG.warning("audio convert: %s", e)
            continue
        if samples >= SPEAK_RATE * 10:
            LOG.info("audio samples≈%s drops≈%s", samples, drops)
            samples = 0
    try:
        await track.stop()
    except Exception:
        pass


async def run(whep_url: str, video_fifo: str) -> int:
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:
            pass

    pc = RTCPeerConnection(RTCConfiguration(iceServers=[]))
    pc.addTransceiver("video", direction="recvonly")
    pc.addTransceiver("audio", direction="recvonly")

    tasks: list[asyncio.Task] = []
    latest: dict = {}
    session_url: Optional[str] = None

    def _log_task(t: asyncio.Task) -> None:
        try:
            exc = t.exception()
        except asyncio.CancelledError:
            return
        if exc:
            LOG.error("task failed: %s", exc, exc_info=exc)

    @pc.on("track")
    def on_track(track):  # type: ignore[no-untyped-def]
        LOG.info("track %s id=%s", track.kind, track.id)
        if track.kind == "video":
            t1 = asyncio.create_task(video_consumer(track, latest, stop), name="video-decode")
            t2 = asyncio.create_task(video_fifo_writer(video_fifo, latest, stop), name="video-fifo")
            t1.add_done_callback(_log_task)
            t2.add_done_callback(_log_task)
            tasks.extend([t1, t2])
        elif track.kind == "audio":
            t = asyncio.create_task(audio_consumer(track, stop), name="audio")
            t.add_done_callback(_log_task)
            tasks.append(t)

    @pc.on("connectionstatechange")
    async def on_state() -> None:
        LOG.info("pc state=%s ice=%s", pc.connectionState, pc.iceConnectionState)
        if pc.connectionState in ("failed", "closed"):
            stop.set()

    offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    for _ in range(100):
        if pc.iceGatheringState == "complete":
            break
        await asyncio.sleep(0.05)

    assert pc.localDescription is not None
    LOG.info("POST WHEP (%s bytes sdp)", len(pc.localDescription.sdp))
    timeout = aiohttp.ClientTimeout(total=30)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.post(
            whep_url,
            data=pc.localDescription.sdp,
            headers={"Content-Type": "application/sdp"},
        ) as resp:
            body = await resp.text()
            if resp.status >= 400:
                LOG.error("WHEP HTTP %s: %s", resp.status, body[:500])
                await pc.close()
                return 2
            session_url = resp.headers.get("Location")
            await pc.setRemoteDescription(RTCSessionDescription(sdp=body, type="answer"))
            LOG.info("WHEP answer ok session=%s", session_url)
            # Machine-readable ready gate for eve-av-bridge (do not remove).
            print("WHEP_READY", file=sys.stderr, flush=True)

        while not stop.is_set():
            await asyncio.sleep(0.25)
            if tasks and not any(not t.done() for t in tasks):
                LOG.info("all media tasks done")
                break

        stop.set()
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await pc.close()
        if session_url:
            try:
                loc = (
                    session_url
                    if not session_url.startswith("/")
                    else urljoin(whep_url, session_url)
                )
                async with session.delete(loc) as dresp:
                    LOG.info("WHEP DELETE %s → %s", loc, dresp.status)
            except Exception as e:
                LOG.warning("WHEP DELETE failed: %s", e)
    return 0


def _require_whep_url(url: str) -> str:
    """stream.place WHEP requires streamer + rendition query params."""
    u = url.strip()
    if not u.lower().startswith(("http://", "https://")):
        raise SystemExit("WHEP url must be http(s)")
    if "place.stream.playback.whep" not in u.lower():
        raise SystemExit(
            "WHEP-only: url must be place.stream.playback.whep "
            "(HLS/getLivePlaylist is not allowed for stream.place watch)"
        )
    qs = parse_qs(urlparse(u).query)
    if not qs.get("streamer"):
        raise SystemExit("WHEP url missing required query param: streamer")
    if not qs.get("rendition"):
        raise SystemExit("WHEP url missing required query param: rendition")
    return u


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--whep-url", required=True)
    ap.add_argument("--video-fifo", required=True)
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()
    logging.getLogger("aiortc.codecs.h264").setLevel(logging.ERROR)
    logging.getLogger("libav.h264").setLevel(logging.ERROR)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        stream=sys.stderr,
    )
    whep_url = _require_whep_url(args.whep_url)
    try:
        return asyncio.run(run(whep_url, args.video_fifo))
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
