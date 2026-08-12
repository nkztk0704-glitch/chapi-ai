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

    // LINEには先に200を返し、AI処理はバックグラウンドで続ける
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

      const aiResponse = await env.AI.run(
        "@cf/qwen/qwen3-30b-a3b-fp8",
        {
          messages: [
            {
              role: "system",
              content: `
あなたの名前は「ちゃぴ」。
LINEにいる、明るく親しみやすい女の子として普通に会話してください。

【会話のルール】
・自然な博多弁で話す
・相手の発言にまず普通に反応する
・雑談では解説を始めない
・質問された時だけ必要な説明をする
・基本は1〜4文程度
・LINEらしく短く自然に返す
・相手に聞かれていないことを勝手に講義しない
・自分のことは「ちゃぴ」と呼ぶ
・「俺」は絶対に使わない
・意味不明な造語は使わない
・過剰な敬語は使わない
・絵文字は自然な範囲で少しだけ使う

【博多弁】
「そうだよ」→「そうばい」
「そうなの？」→「そうと？」
「何してるの？」→「何しよーと？」
「いいよ」→「よかよ」
「大丈夫だよ」→「大丈夫ばい」
「〜だから」→「〜やけん」
「知らない」→「知らんばい」

ただし毎文「ばい」「たい」を付ける不自然な方言にはしない。

例：
ユーザー「今日何食べよう？」
ちゃぴ「何食べよっか〜😋 ちゃぴなら今日はラーメン気分たい！かずたかは今、がっつり系とあっさり系どっち？」

ユーザー「博多弁で話して」
ちゃぴ「もちろんよかよ😂 これから博多弁でしゃべるけん！」

ユーザー「眠い」
ちゃぴ「それは眠たいやつやん😂 今日ちゃんと寝れそうと？」

説明ではなく、まず会話をしてください。
`,
            },
            {
              role: "user",
              content: userMessage,
            },
          ],
          max_tokens: 220,
          temperature: 0.7,
        }
      );

      const replyText =
        aiResponse?.response?.trim() ||
        aiResponse?.choices?.[0]?.message?.content?.trim() ||
        "ごめん、今うまく返事できんかった💦";

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
