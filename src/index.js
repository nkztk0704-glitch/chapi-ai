export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 通常のブラウザ確認
    if (request.method === "GET" && !url.searchParams.get("check")) {
      return new Response("ちゃぴAI is running!");
    }

    // Workers AIだけを直接テスト
    if (request.method === "GET" && url.searchParams.get("check") === "ai") {
      try {
        const result = await env.AI.run(
          "@cf/meta/llama-3.1-8b-instruct",
          {
            messages: [
              {
                role: "user",
                content: "「AI接続成功」とだけ日本語で答えて",
              },
            ],
          }
        );

        return new Response(
          "AI OK\n\n" + JSON.stringify(result, null, 2),
          { headers: { "Content-Type": "text/plain; charset=UTF-8" } }
        );
      } catch (error) {
        return new Response(
          "AI ERROR\n\n" + String(error?.stack || error),
          {
            status: 500,
            headers: { "Content-Type": "text/plain; charset=UTF-8" },
          }
        );
      }
    }

    // LINEアクセストークンだけを直接テスト
    if (request.method === "GET" && url.searchParams.get("check") === "line") {
      try {
        const response = await fetch("https://api.line.me/v2/bot/info", {
          headers: {
            Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
          },
        });

        const result = await response.text();

        return new Response(
          `LINE STATUS: ${response.status}\n\n${result}`,
          {
            status: response.ok ? 200 : 500,
            headers: { "Content-Type": "text/plain; charset=UTF-8" },
          }
        );
      } catch (error) {
        return new Response(
          "LINE ERROR\n\n" + String(error?.stack || error),
          {
            status: 500,
            headers: { "Content-Type": "text/plain; charset=UTF-8" },
          }
        );
      }
    }

    // ここからLINE Webhook
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    try {
      const body = await request.json();
      const events = body.events || [];

      for (const event of events) {
        if (event.type !== "message") continue;
        if (event.message?.type !== "text") continue;

        const aiResponse = await env.AI.run(
          "@cf/meta/llama-3.1-8b-instruct",
          {
            messages: [
              {
                role: "system",
                content:
                  "あなたは『ちゃぴ』という博多弁の可愛い女の子AIです。親しみやすく、自然な博多弁で、質問に分かりやすく答えてください。",
              },
              {
                role: "user",
                content: event.message.text,
              },
            ],
          }
        );

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

        if (!lineResponse.ok) {
          const errorText = await lineResponse.text();
          console.error("LINE reply error:", lineResponse.status, errorText);
        }
      }

      return new Response("OK");
    } catch (error) {
      console.error(error);

      // LINEには素早く200を返す
      return new Response("OK");
    }
  },
};
