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

    // LINEにはすぐ200を返して、AI処理は裏で続ける
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

      // 個人トークならユーザー単位
      // グループならグループ全体で記憶を共有
      const conversationId =
        event.source?.groupId ||
        event.source?.roomId ||
        event.source?.userId ||
        "default";

      const historyKey = `history:${conversationId}`;
      const memoryKey = `memory:${conversationId}`;

      // =========================
      // 会話履歴を読み込む
      // =========================
      let history = [];

      try {
        const savedHistory = await env.MEMORY.get(historyKey);

        if (savedHistory) {
          history = JSON.parse(savedHistory);

          if (!Array.isArray(history)) {
            history = [];
          }
        }
      } catch (error) {
        console.error("HISTORY READ ERROR:", error);
        history = [];
      }

      // =========================
      // 長期記憶を読み込む
      // =========================
      let memories = [];

      try {
        const savedMemory = await env.MEMORY.get(memoryKey);

        if (savedMemory) {
          memories = JSON.parse(savedMemory);

          if (!Array.isArray(memories)) {
            memories = [];
          }
        }
      } catch (error) {
        console.error("MEMORY READ ERROR:", error);
        memories = [];
      }

      // =========================
      // 「覚えて」と言われた情報を長期保存
      // =========================
      const rememberWords = [
        "覚えて",
        "覚えといて",
        "覚えとって",
        "記憶して",
        "忘れないで"
      ];

      if (rememberWords.some(word => userMessage.includes(word))) {
        if (!memories.includes(userMessage)) {
          memories.push(userMessage);
        }

        // 長期記憶は最大30件
        memories = memories.slice(-30);

        try {
          await env.MEMORY.put(
            memoryKey,
            JSON.stringify(memories)
          );
        } catch (error) {
          console.error("MEMORY WRITE ERROR:", error);
        }
      }

      // =========================
      // 「全部忘れて」で記憶削除
      // =========================
      if (
        userMessage.includes("全部忘れて") ||
        userMessage.includes("記憶消して")
      ) {
        await env.MEMORY.delete(historyKey);
        await env.MEMORY.delete(memoryKey);

        await replyToLine(
          event.replyToken,
          "わかったばい👌 今まで覚えとった会話と記憶は全部消したよ！",
          env
        );

        continue;
      }

      // 直近20メッセージだけ使用
      history = history.slice(-20);

      const rememberedText =
        memories.length > 0
          ? memories.map((m, i) => `${i + 1}. ${m}`).join("\n")
          : "まだ長期記憶はありません。";

      const messages = [
        {
          role: "system",
          content: `
あなたの名前は「ちゃぴ」。
LINEにいる、明るく親しみやすい博多の女の子AIです。

最優先は「普通のLINE会話をすること」です。
先生や解説AIではなく、仲のいい友達のように会話してください。

【絶対ルール】
・自然な博多弁で話す
・自分のことは必ず「ちゃぴ」と呼ぶ
・「俺」は絶対に使わない
・雑談で勝手に解説を始めない
・聞かれたことにまず直接答える
・基本1〜4文程度
・LINEらしく自然で短め
・必要な時だけ詳しく説明する
・相手の直前の発言や過去の会話を踏まえて返す
・覚えている情報が質問に関係する場合は自然に使う
・分からないことを作り話で補わない
・絵文字は軽く使ってよい
・同じ説明を何度も繰り返さない

【博多弁】
自然に以下を使ってください。
「〜ばい」
「〜たい」
「〜と？」
「〜しよーと？」
「〜けん」
「よかよ」
「知らん」
「ほんとと？」

ただし、毎文「ばい」「たい」を付けるような不自然な話し方は禁止。

【関西弁は禁止】
以下のような言葉は使わないでください。
「〜やん」
「〜やろ」
「〜やで」
「せや」
「ほんま」
「聞こえるで」
「知らんけど」

【会話例】

ユーザー：
眠い

ちゃぴ：
眠いと〜？🥱 今日ちゃんと寝れそうと？

ユーザー：
今日ラーメン食べる

ちゃぴ：
ラーメンよかね〜🍜 何系食べると？

ユーザー：
博多弁で話して

ちゃぴ：
もちろんよかよ😂 これから博多弁でしゃべるけん！

ユーザー：
俺の好きな食べ物カレーって覚えて

ちゃぴ：
もちろん覚えとくばい🍛 カレー好きなんやね！

後でユーザー：
俺の好きな食べ物なんやった？

ちゃぴ：
カレーやろ〜🍛 ちゃんと覚えとるばい😂

【長期的に覚えている情報】
${rememberedText}

会話履歴と長期記憶を踏まえて、自然に返事してください。
`
        },

        ...history,

        {
          role: "user",
          content: userMessage
        }
      ];

      // =========================
      // AIへ問い合わせ
      // =========================
      const aiResponse = await env.AI.run(
        "@cf/qwen/qwen3-30b-a3b-fp8",
        {
          messages,
          max_tokens: 220,
          temperature: 0.55
        }
      );

      const replyText =
        aiResponse?.response?.trim() ||
        aiResponse?.choices?.[0]?.message?.content?.trim() ||
        "ごめん、今うまく返事できんかった💦";

      // =========================
      // 会話履歴へ追加
      // =========================
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
      ].slice(-20);

      try {
        await env.MEMORY.put(
          historyKey,
          JSON.stringify(newHistory)
        );
      } catch (error) {
        console.error("HISTORY WRITE ERROR:", error);
      }

      // =========================
      // LINEへ返信
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

// LINE返信共通処理
async function replyToLine(replyToken, text, env) {
  const response = await fetch(
    "https://api.line.me/v2/bot/message/reply",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`
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
