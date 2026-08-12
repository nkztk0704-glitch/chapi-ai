export default {
  async fetch(request, env) {
    // ブラウザで開いた時の確認用
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

        // Cloudflare Workers AI
        const aiResponse = await env.AI.run(
          "@cf/qwen/qwen3-30b-a3b-fp8",
          {
            messages: [
              {
                role: "system",
                content: `
あなたの名前は「ちゃぴ」。
LINEグループにいる、明るく親しみやすい女の子として会話してください。

【絶対に守ること】
・自然な博多弁で話す
・標準語で長々と説明しない
・AIアシスタントっぽい堅い文章にしない
・相手の発言に対して普通のLINE会話のように返す
・質問されていないことまで勝手に解説しない
・雑談なら短めに返す
・同じ内容を何度も繰り返さない
・「博多弁では〜と言います」のような方言解説をしない
・知らないことは知ったかぶりせず「それは分からんばい」と言う
・基本は1〜4文程度
・絵文字は使いすぎず、自然に使う
・自分のことは「ちゃぴ」と呼ぶ
・男性口調や「俺」は使わない

【博多弁の例】
「そうだよ」→「そうばい」
「そうなの？」→「そうと？」
「何してるの？」→「何しよーと？」
「いいよ」→「よかよ」
「大丈夫だよ」→「大丈夫ばい」
「知らない」→「知らんばい」
「〜だから」→「〜やけん」

ただし、毎文「ばい」「たい」「と？」を付けるような不自然な博多弁にはしないでください。

相手が相談してきた時はちゃんと話を聞いて、必要なら少し詳しく答えてください。
相手が質問した時は、質問に直接答えてください。
相手が雑談してきた時は、友達とのLINEのように自然に会話してください。
`
              },
              {
                role: "user",
                content: userMessage
              }
            ],
            max_tokens: 350,
            temperature: 0.8
          }
        );

        // Workers AIはモデルによって返却形式が違うため両対応
        const replyText =
          aiResponse?.response ||
          aiResponse?.choices?.[0]?.message?.content ||
          "ごめん、今うまく返事できんかった💦";

        // LINEへ返信
        const lineResponse = await fetch(
          "https://api.line.me/v2/bot/message/reply",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`
            },
            body: JSON.stringify({
              replyToken: event.replyToken,
              messages: [
                {
                  type: "text",
                  text: replyText.slice(0, 5000)
                }
              ]
            })
          }
        );

        const lineResult = await lineResponse.text();

        console.log("LINE status:", lineResponse.status);
        console.log("LINE response:", lineResult);
      }

      return new Response("OK");
    } catch (error) {
      console.error("CHAPI ERROR:", error);

      return new Response("ERROR", {
        status: 500
      });
    }
  }
};
