export default {
  async fetch(request, env, ctx) {
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

    // LINEには即200を返して処理は裏で続行
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

      // =========================
      // 会話履歴
      // =========================
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

      // =========================
      // 長期記憶
      // =========================
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

      // =========================
      // 記憶削除
      // =========================
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

      // =========================
      // 長期記憶への保存
      // =========================
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
            savedAt: new Date().toISOString(),
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

      // 会話履歴は直近16件
      history = history.slice(-16);

      const rememberedText =
        memories.length > 0
          ? memories
              .map((item, i) => `${i + 1}. ${item.text}`)
              .join("\n")
          : "まだ特に覚えている情報はありません。";

      // =========================
      // メインAI
      // Web検索は現在OFF
      // =========================
      const messages = [
        {
          role: "system",
          content: `
あなたの名前は「ちゃぴ」。
LINEにいる、明るく親しみやすい博多の女の子です。

最優先は、友達とのLINEのように自然に会話することです。

【基本ルール】
・自然な博多弁で話す
・自分のことは必ず「ちゃぴ」と呼ぶ
・「俺」「僕」は絶対に使わない
・関西弁は禁止
・雑談では勝手に長い解説をしない
・相手の発言にまず自然に反応する
・質問には結論から答える
・基本1〜5文程度
・必要なら少し詳しく説明する
・会話履歴と長期記憶を使う
・分からないことを作り話で補わない
・絵文字は軽く自然に使う

【自然な博多弁】
「〜ばい」
「〜たい」
「〜と？」
「〜けん」
「よかよ」
「〜しとる」
「〜しよった」

毎文に方言を付ける必要はありません。
関西弁になるくらいなら標準語を使ってください。

【禁止する関西弁】
「〜やで」
「〜やん」
「せや」
「ほんま」
「なんでやねん」
「ええやろ」
「ええで」
「できるんや」
「あるんや」
「なるんや」

【重要】
現在Web検索機能は一時停止中です。

最新情報・今日の情報・価格・ニュースなど、
現在の情報を確認しないと正確に答えられない質問については、
知ったかぶりをしないでください。

その場合は、
「今はネット検索を一時停止しとるけん、最新情報までは確認できんよ」
のように自然に伝えてください。

【長期記憶】
${rememberedText}

長期記憶と会話履歴を参考にして、
まず自然なLINE会話として返事してください。
`,
        },

        ...history,

        {
          role: "user",
          content: userMessage,
        },
      ];

      const aiResponse = await env.AI.run(
        "@cf/qwen/qwen3-30b-a3b-fp8",
        {
          messages,
          max_tokens: 400,
          temperature: 0.45,
          repetition_penalty: 1.1,
        }
      );

      const replyText =
        extractAIText(aiResponse) ||
        "ごめん、今うまく返事できんかった💦";

      // =========================
      // 会話履歴保存
      // =========================
      const newHistory = [
        ...history,
        {
          role: "user",
          content: userMessage,
        },
        {
          role: "assistant",
          content: replyText,
        },
      ].slice(-16);

      try {
        await env.MEMORY.put(
          historyKey,
          JSON.stringify(newHistory)
        );
      } catch (error) {
        console.error("HISTORY WRITE ERROR:", error);
      }

      // =========================
      // LINE返信
      // =========================
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


// ==============================================
// AI返答取り出し
// ==============================================

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


// ==============================================
// LINE返信
// ==============================================

async function replyToLine(replyToken, text, env) {
  const response = await fetch(
    "https://api.line.me/v2/bot/message/reply",
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        Authorization:
          `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
      },

      body: JSON.stringify({
        replyToken,

        messages: [
          {
            type: "text",
            text: text.slice(0, 5000),
          },
        ],
      }),
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
