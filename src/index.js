export default {
  async fetch(request, env) {
    console.log("=== CHAPI START ===");
    console.log("Method:", request.method);

    if (request.method !== "POST") {
      return new Response("ちゃぴAI is running!");
    }

    try {
      const body = await request.json();
      console.log("Webhook body:", JSON.stringify(body));

      const events = body.events || [];

      for (const event of events) {
        console.log("Event type:", event.type);

        if (event.type !== "message") continue;
        if (event.message?.type !== "text") continue;

        const userMessage = event.message.text;
        console.log("User message:", userMessage);

        const aiResponse = await env.AI.run(
          "@cf/meta/llama-3.1-8b-instruct",
          {
            messages: [
              {
                role: "system",
                content:
                  "あなたは『ちゃぴ』という博多弁の可愛い女の子AIです。親しみやすく自然な博多弁で答えてください。質問には分かりやすく答えてください。",
              },
              {
                role: "user",
                content: userMessage,
              },
            ],
          }
        );

        console.log("AI response:", JSON.stringify(aiResponse));

        const replyText =
          aiResponse?.response ||
          "ごめんね、ちゃぴ今ちょっと調子悪いみたい🥺";

        const lineResponse = await fetch(
          "https://api.line.me/v2/bot/message/reply",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
            },
            body: JSON.stringify({
              replyToken: event.replyToken,
              messages: [
                {
                  type: "text",
                  text: replyText.slice(0, 5000),
                },
              ],
            }),
          }
        );

        const lineResult = await lineResponse.text();

        console.log("LINE status:", lineResponse.status);
        console.log("LINE response:", lineResult);
      }

      console.log("=== CHAPI END ===");
      return new Response("OK");
    } catch (error) {
      console.error("=== CHAPI ERROR ===");
      console.error(error);

      return new Response("ERROR", {
        status: 500,
      });
    }
  },
};
