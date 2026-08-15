import { defineChannel, GET, POST } from "eve/channels";
export default defineChannel({ routes: [
 GET("/agent.card", async () => Response.json({ name: "Eve", url: "https://eve.boxd.sh/orchestral" })),
 POST("/message", async (req, { send }) => { const b: any = await req.json(); const text = (b?.message?.parts ?? []).map((p: any) => p.text ?? "").join(""); const s = await send(text, { auth: null }); return Response.json({ task: { id: s.id, status: { state: "submitted" } } }); }),
] });
