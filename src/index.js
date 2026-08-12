export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("ちゃぴAI is running!");
    }

    try {
      const body = await request.json();

      const events = body.events || [];

      for (const event of events) {
        if (event.type !== "message") continue;
        if (event.message?.type !== "text") continue;

        const userMessage = event.message.text;

        const aiResponse = await env.AI.run(
          "@cf/meta/llama-3.1-8b-instruct",
          {
            messages: [
              {
                role: "system",
                content:
                  "あなたは『ちゃぴ』という博多弁の可愛い女の子AIです。親しみやすく、自然な博多弁で答えてください。質問には分かりやすく答えてください。",
              },
              {
                role: "user",
                content: userMessage,
              },
            ],
          }
        );

        const replyText =
          aiResponse?.response ||
          "ごめんね、ちゃぴ今ちょっと調子悪いみたい🥺";

        await fetch("https://api.line.me/v2/bot/message/reply", {
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
        });
      }

      return new Response("OK");
    } catch (error) {
      console.error(error);
      return new Response("ERROR", { status: 500 });
    }
  },
};
