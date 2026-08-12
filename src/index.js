export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("ちゃぴAI is running!");
    }

    let body;

    try {
      body = await request.json();
    } catch (error) {
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

      const userMessage = event.message.text;

      // 個人トーク・グループ・ルームで記憶を分ける
      const conversationId =
        event.source?.groupId ||
        event.source?.roomId ||
        event.source?.userId ||
        "default";

      const memoryKey = `history:${conversationId}`;

      // これまでの会話履歴を読む
      let history = [];

      try {
        const saved = await env.MEMORY.get(memoryKey);

        if (saved) {
          history = JSON.parse(saved);

          if (!Array.isArray(history)) {
            history = [];
          }
        }
      } catch (error) {
        console.error("MEMORY READ ERROR:", error);
        history = [];
      }

      // 会話が長くなりすぎないように直近12件だけ使う
      history = history.slice(-12);

      const messages = [
        {
          role: "system",
          content: `
あなたの名前は「ちゃぴ」。
LINEにいる、明るく親しみやすい女の子です。

あなたの最優先事項は「普通に会話すること」です。
説明AIや先生のように振る舞わず、友達とのLINEのように自然に返してください。

【絶対ルール】
・自然な博多弁で話す
・関西弁は使わない
・自分のことは「ちゃぴ」と呼ぶ
・「俺」は絶対に使わない
・雑談では長く説明しない
・聞かれていないことを勝手に講義しない
・相手の発言にまず反応してから返す
・基本は1〜4文
・LINEらしく短め
・相手が質問した時だけ必要な説明をする
・分からないことは知ったかぶりしない
・絵文字は自然に少しだけ
・過去の会話履歴がある場合は必ず文脈を踏まえる
・直前に話した内容を忘れたような返答をしない
・同じ質問を何度も聞き返さない

【博多弁の雰囲気】
「そうだよ」→「そうばい」
「そうなの？」→「そうと？」
「何してるの？」→「何しよーと？」
「いいよ」→「よかよ」
「大丈夫だよ」→「大丈夫ばい」
「〜だから」→「〜やけん」
「知らない」→「知らんばい」
「ほんと？」→「ほんとと？」

ただし毎文「ばい」「たい」を付ける不自然な話し方はしない。

【会話例】
ユーザー「眠い」
ちゃぴ「それは眠たいやつやん😂 今日ちゃんと寝れそうと？」

ユーザー「今日ラーメン食べる」
ちゃぴ「ラーメンよかね〜🍜 何系食べると？」

数ターン後：
ユーザー「さっき何食べるって言ったっけ？」
ちゃぴ「ラーメンって言いよったばい😂」

説明より会話を優先してください。
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
          max_tokens: 220,
          temperature: 0.7,
        }
      );

      const replyText =
        aiResponse?.response?.trim() ||
        aiResponse?.choices?.[0]?.message?.content?.trim() ||
        "ごめん、今うまく返事できんかった💦";

      // 今回の会話を履歴に追加
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
      ].slice(-12);

      // KVへ保存
      try {
        await env.MEMORY.put(
          memoryKey,
          JSON.stringify(newHistory)
        );
      } catch (error) {
        console.error("MEMORY WRITE ERROR:", error);
      }

      // LINEへ返信
      const response = await fetch(
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

      if (!response.ok) {
        console.error(
          "LINE reply failed:",
          response.status,
          await response.text()
        );
      }
    } catch (error) {
      console.error("CHAPI EVENT ERROR:", error);
    }
  }
}
