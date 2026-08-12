export default {
  async fetch(request, env) {

    // ブラウザでWorkerが動いているか確認
    if (request.method !== "POST") {

      // AI単体テスト
      const url = new URL(request.url);

      if (url.searchParams.get("check") === "ai") {
        try {
          const aiResponse = await env.AI.run(
            "@cf/meta/llama-3.2-3b-instruct",
            {
              messages: [
                {
                  role: "user",
                  content: "こんにちは。短く返事してください。",
                },
              ],
            }
          );

          return new Response(
            "AI OK\n\n" + JSON.stringify(aiResponse),
            {
              headers: {
                "Content-Type": "text/plain; charset=UTF-8",
              },
            }
          );
        } catch (error) {
          return new Response(
            "AI ERROR\n\n" +
              (error?.stack || error?.message || String(error)),
            {
              status: 500,
              headers: {
                "Content-Type": "text/plain; charset=UTF-8",
              },
            }
          );
        }
      }

      // LINEアクセストークン単体テスト
      if (url.searchParams.get("check") === "line") {
        try {
          const response = await fetch(
            "https://api.line.me/v2/bot/info",
            {
              headers: {
                Authorization:
                  `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
              },
            }
          );

          const text = await response.text();

          return new Response(
            `LINE STATUS: ${response.status}\n\n${text}`,
            {
              headers: {
                "Content-Type": "text/plain; charset=UTF-8",
              },
            }
          );
        } catch (error) {
          return new Response(
            "LINE ERROR\n\n" +
              (error?.stack || error?.message || String(error)),
            {
              status: 500,
              headers: {
                "Content-Type": "text/plain; charset=UTF-8",
              },
            }
          );
        }
      }

      return new Response("ちゃぴAI is running!");
    }

    try {
      console.log("=== CHAPI START ===");
      console.log("Method:", request.method);

      const body = await request.json();

      console.log(
        "Webhook body:",
        JSON.stringify(body)
      );

      const events = body.events || [];

      for (const event of events) {

        console.log(
          "Event type:",
          event.type
        );

        if (event.type !== "message") continue;

        if (event.message?.type !== "text") continue;

        const userMessage = event.message.text;

        console.log(
          "User message:",
          userMessage
        );

        // Workers AI
        const aiResponse = await env.AI.run(
          "@cf/meta/llama-3.2-3b-instruct",
          {
            messages: [
              {
                role: "system",
                content:
                  "あなたは『ちゃぴ』という博多弁の可愛い女の子AIです。親しみやすく自然な博多弁で答えてください。質問には分かりやすく、できるだけ正確に答えてください。",
              },
              {
                role: "user",
                content: userMessage,
              },
            ],
          }
        );

        console.log(
          "AI response:",
          JSON.stringify(aiResponse)
        );

        const replyText =
          aiResponse?.response ||
          "ごめんね、ちゃぴ今ちょっと調子悪いみたい🥺";

        // LINEへ返信
        const lineResponse = await fetch(
          "https://api.line.me/v2/bot/message/reply",
          {
            method: "POST",

            headers: {
              "Content-Type": "application/json",
              Authorization:
                `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
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

        const lineResult =
          await lineResponse.text();

        console.log(
          "LINE status:",
          lineResponse.status
        );

        console.log(
          "LINE response:",
          lineResult
        );
      }

      console.log("=== CHAPI END ===");

      return new Response("OK");

    } catch (error) {

      console.error(
        "=== CHAPI ERROR ==="
      );

      console.error(error);

      return new Response(
        "ERROR",
        {
          status: 500,
        }
      );
    }
  },
};
