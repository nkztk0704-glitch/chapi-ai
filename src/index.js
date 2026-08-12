export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Worker稼働確認
    if (request.method === "GET" && !url.searchParams.get("check")) {
      return new Response("ちゃぴAI is running!");
    }

    // AI単体テスト
    if (request.method === "GET" && url.searchParams.get("check") === "ai") {
      try {
        const result = await env.AI.run(
          "@cf/meta/llama-3.1-8b-instruct-fast",
          {
            messages: [
              {
                role: "system",
                content:
                  "あなたは日本語で自然に会話するAIです。変な言い回しや不自然な造語は使わず、簡潔で読みやすい日本語で返答してください。",
              },
              {
                role: "user",
                content: "こんにちは。自然な日本語で短く返事して。",
              },
            ],
            temperature: 0.4,
            max_tokens: 120,
          }
        );

        return new Response(
          "AI OK\n\n" + JSON.stringify(result, null, 2),
          {
            headers: {
              "Content-Type": "text/plain; charset=UTF-8",
            },
          }
        );
      } catch (error) {
        return new Response(
          "AI ERROR\n\n" + String(error?.stack || error),
          {
            status: 500,
            headers: {
              "Content-Type": "text/plain; charset=UTF-8",
            },
          }
        );
      }
    }

    // LINEトークン単体テスト
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
            headers: {
              "Content-Type": "text/plain; charset=UTF-8",
            },
          }
        );
      } catch (error) {
        return new Response(
          "LINE ERROR\n\n" + String(error?.stack || error),
          {
            status: 500,
            headers: {
              "Content-Type": "text/plain; charset=UTF-8",
            },
          }
        );
      }
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    try {
      const body = await request.json();
      const events = body.events || [];

      for (const event of events) {
        if (event.type !== "message") continue;
        if (event.message?.type !== "text") continue;

        const userMessage = event.message.text;

        const aiResponse = await env.AI.run(
          "@cf/meta/llama-3.1-8b-instruct-fast",
          {
            messages: [
              {
                role: "system",
                content:
                  "あなたは『ちゃぴ』という親しみやすい女の子AIです。日本語で自然に会話してください。基本は標準語ですが、語尾や相づちに軽く自然な博多弁を混ぜてください。博多弁を無理に連発しないでください。『〜たい』『〜ばい』『〜と？』『〜けん』などを自然な範囲で使ってください。変な造語、意味不明な表現、不自然な敬語、過剰なテンションは禁止です。質問には最初に結論を答えて、そのあと必要な説明をしてください。分からないことは無理に作らず、分からないと伝えてください。LINEで読みやすいように、返答は基本3〜8行程度にしてください。",
              },
              {
                role: "user",
                content: userMessage,
              },
            ],
            temperature: 0.4,
            max_tokens: 350,
            repetition_penalty: 1.1,
          }
        );

        const replyText =
          aiResponse?.response?.trim() ||
          "ごめんね、今ちょっと上手く答えられんかった🥺 もう一回聞いてみて！";

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
          console.error(
            "LINE reply error:",
            lineResponse.status,
            errorText
          );
        }
      }

      return new Response("OK");
    } catch (error) {
      console.error("CHAPI ERROR:", error);

      // LINE側には200を返して再送ループを防ぐ
      return new Response("OK");
    }
  },
};
