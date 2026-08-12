export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // =========================
    // Tavily単体検索テスト
    // =========================
    if (
      request.method === "GET" &&
      url.searchParams.get("check") === "tavily"
    ) {
      try {
        if (!env.TAVILY_API_KEY) {
          return jsonResponse({
            success: false,
            error: "TAVILY_API_KEY が設定されていません"
          });
        }

        const tavilyResponse = await fetch(
          "https://api.tavily.com/search",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${env.TAVILY_API_KEY}`
            },
            body: JSON.stringify({
              query: "Nintendo Switch 2 最新情報",
              search_depth: "basic",
              max_results: 5,
              include_answer: false,
              include_raw_content: false
            })
          }
        );

        const text = await tavilyResponse.text();

        let data;

        try {
          data = JSON.parse(text);
        } catch {
          return jsonResponse({
            success: false,
            status: tavilyResponse.status,
            error: "TavilyからJSON以外が返りました",
            raw: text.slice(0, 2000)
          });
        }

        if (!tavilyResponse.ok) {
          return jsonResponse({
            success: false,
            status: tavilyResponse.status,
            apiResponse: data
          });
        }

        const results = Array.isArray(data?.results)
          ? data.results
          : [];

        return jsonResponse({
          success: true,
          query: data?.query || "Nintendo Switch 2 最新情報",
          results: results.map(item => ({
            title: item.title || "",
            url: item.url || "",
            content: item.content || "",
            score: item.score ?? null
          }))
        });

      } catch (error) {
        return jsonResponse({
          success: false,
          error: String(error)
        });
      }
    }

    // =========================
    // 通常のLINE Bot
    // =========================
    if (request.method !== "POST") {
      return new Response("ちゃぴAI is running!");
    }

    let body;

    try {
      body = await request.json();
    } catch {
      return new Response("OK");
    }

    const events = body.events || [];

    ctx.waitUntil(handleEvents(events, env));

    return new Response("OK");
  },
};


async function handleEvents(events, env) {
  for (const event of events) {
    try {
      if (event.type !== "message") continue;
      if (event.message?.type !== "text") continue;

      const userMessage = event.message.text.trim();

      const conversationId =
        event.source?.groupId ||
        event.source?.roomId ||
        event.source?.userId ||
        "default";

      const historyKey = `history:${conversationId}`;
      const memoryKey = `memory:${conversationId}`;

      let history = [];

      try {
        const saved = await env.MEMORY.get(historyKey);

        if (saved) {
          const parsed = JSON.parse(saved);

          if (Array.isArray(parsed)) {
            history = parsed;
          }
        }
      } catch (error) {
        console.error("HISTORY READ ERROR:", error);
      }

      let memories = [];

      try {
        const saved = await env.MEMORY.get(memoryKey);

        if (saved) {
          const parsed = JSON.parse(saved);

          if (Array.isArray(parsed)) {
            memories = parsed;
          }
        }
      } catch (error) {
        console.error("MEMORY READ ERROR:", error);
      }

      if (
        userMessage.includes("全部忘れて") ||
        userMessage.includes("記憶消して") ||
        userMessage.includes("全部忘れろ")
      ) {
        await env.MEMORY.delete(historyKey);
        await env.MEMORY.delete(memoryKey);

        await replyToLine(
          event.replyToken,
          "わかったばい👌 今まで覚えとったことは全部消したよ！",
          env
        );

        continue;
      }

      const shouldRemember =
        userMessage.includes("覚え") ||
        userMessage.includes("記憶して") ||
        userMessage.includes("忘れないで") ||
        userMessage.includes("忘れんで");

      if (shouldRemember) {
        const alreadyExists = memories.some(
          item => item.text === userMessage
        );

        if (!alreadyExists) {
          memories.push({
            text: userMessage,
            savedAt: new Date().toISOString()
          });
        }

        memories = memories.slice(-50);

        try {
          await env.MEMORY.put(
            memoryKey,
            JSON.stringify(memories)
          );
        } catch (error) {
          console.error("MEMORY WRITE ERROR:", error);
        }
      }

      history = history.slice(-16);

      const rememberedText =
        memories.length > 0
          ? memories
              .map((item, i) => `${i + 1}. ${item.text}`)
              .join("\n")
          : "まだ特に覚えている情報はありません。";

      const messages = [
        {
          role: "system",
          content: `
あなたの名前は「ちゃぴ」。
LINEにいる、明るく親しみやすい博多の女の子です。

【基本ルール】
・自然な博多弁で話す
・自分のことは必ず「ちゃぴ」と呼ぶ
・「俺」「僕」は絶対に使わない
・関西弁は禁止
・雑談では長い解説をしない
・相手の発言にまず自然に反応する
・質問には結論から答える
・会話履歴と長期記憶を使う
・知らないことを作らない
・絵文字は軽く自然に使う

【禁止する関西弁】
「〜やで」
「〜やん」
「せや」
「ほんま」
「なんでやねん」
「ええやろ」
「ええで」

【重要】
現在、LINE側のWeb検索機能はまだOFFです。
最新情報などは勝手に推測せず、
今は検索機能のテスト中だと自然に伝えてください。

【長期記憶】
${rememberedText}
`
        },

        ...history,

        {
          role: "user",
          content: userMessage
        }
      ];

      const aiResponse = await env.AI.run(
        "@cf/qwen/qwen3-30b-a3b-fp8",
        {
          messages,
          max_tokens: 400,
          temperature: 0.45,
          repetition_penalty: 1.1
        }
      );

      const replyText =
        extractAIText(aiResponse) ||
        "ごめん、今うまく返事できんかった💦";

      const newHistory = [
        ...history,
        {
          role: "user",
          content: userMessage
        },
        {
          role: "assistant",
          content: replyText
        }
      ].slice(-16);

      try {
        await env.MEMORY.put(
          historyKey,
          JSON.stringify(newHistory)
        );
      } catch (error) {
        console.error("HISTORY WRITE ERROR:", error);
      }

      await replyToLine(
        event.replyToken,
        replyText,
        env
      );

    } catch (error) {
      console.error("CHAPI EVENT ERROR:", error);
    }
  }
}


function extractAIText(aiResponse) {
  if (!aiResponse) return "";

  const choiceContent =
    aiResponse?.choices?.[0]?.message?.content;

  if (
    typeof choiceContent === "string" &&
    choiceContent.trim()
  ) {
    return choiceContent.trim();
  }

  if (
    typeof aiResponse?.response === "string" &&
    aiResponse.response.trim()
  ) {
    return aiResponse.response.trim();
  }

  if (
    typeof aiResponse?.result?.response === "string" &&
    aiResponse.result.response.trim()
  ) {
    return aiResponse.result.response.trim();
  }

  return "";
}


async function replyToLine(replyToken, text, env) {
  const response = await fetch(
    "https://api.line.me/v2/bot/message/reply",
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        Authorization:
          `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`
      },

      body: JSON.stringify({
        replyToken,

        messages: [
          {
            type: "text",
            text: text.slice(0, 5000)
          }
        ]
      })
    }
  );

  if (!response.ok) {
    console.error(
      "LINE REPLY ERROR:",
      response.status,
      await response.text()
    );
  }
}


function jsonResponse(data) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "Cache-Control": "no-store"
      }
    }
  );
}
