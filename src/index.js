export default {
  async fetch(request, env, ctx) {

    // ==========================================
    // SerpApi.Org 単体検索テスト
    // ==========================================
    if (request.method === "GET") {
      const url = new URL(request.url);

      if (url.searchParams.get("check") === "search") {
        try {
          if (!env.SERPAPI_API_KEY) {
            return jsonResponse({
              success: false,
              error: "SERPAPI_API_KEY が設定されていません"
            });
          }

          const searchUrl = new URL(
            "https://serpapi.org/api/v1/webs-search"
          );

          searchUrl.searchParams.set(
            "keyword",
            "ダダサバイバー 最新情報"
          );

          searchUrl.searchParams.set("gl", "JP");
          searchUrl.searchParams.set("hl", "ja");
          searchUrl.searchParams.set("size", "5");

          searchUrl.searchParams.set(
            "token",
            env.SERPAPI_API_KEY
          );

          const response = await fetch(
            searchUrl.toString()
          );

          const text = await response.text();

          let data;

          try {
            data = JSON.parse(text);
          } catch {
            return jsonResponse({
              success: false,
              status: response.status,
              error: "検索APIからJSON以外が返りました",
              raw: text.slice(0, 3000)
            });
          }

          if (!response.ok) {
            return jsonResponse({
              success: false,
              status: response.status,
              rawApiResponse: data
            });
          }

          // ======================================
          // 今回はAPIの返答構造を確認するため
          // 加工せずそのまま表示
          // ======================================
          return jsonResponse({
            success: true,
            query: "ダダサバイバー 最新情報",
            httpStatus: response.status,
            rawApiResponse: data
          });

        } catch (error) {
          return jsonResponse({
            success: false,
            error: String(error)
          });
        }
      }

      return new Response("ちゃぴAI is running!");
    }

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

    // LINEにはすぐ200を返して、処理は裏で続ける
    ctx.waitUntil(handleEvents(events, env));

    return new Response("OK");
  },
};


async function handleEvents(events, env) {

  for (const event of events) {

    try {

      if (event.type !== "message") continue;
      if (event.message?.type !== "text") continue;

      const userMessage =
        event.message.text.trim();

      // 個人ならユーザー単位
      // グループならグループ単位で記憶
      const conversationId =
        event.source?.groupId ||
        event.source?.roomId ||
        event.source?.userId ||
        "default";

      const historyKey =
        `history:${conversationId}`;

      const memoryKey =
        `memory:${conversationId}`;


      // ==========================================
      // 会話履歴を読む
      // ==========================================

      let history = [];

      try {

        const savedHistory =
          await env.MEMORY.get(historyKey);

        if (savedHistory) {

          const parsed =
            JSON.parse(savedHistory);

          if (Array.isArray(parsed)) {
            history = parsed;
          }

        }

      } catch (error) {

        console.error(
          "HISTORY READ ERROR:",
          error
        );

      }


      // ==========================================
      // 長期記憶を読む
      // ==========================================

      let memories = [];

      try {

        const savedMemory =
          await env.MEMORY.get(memoryKey);

        if (savedMemory) {

          const parsed =
            JSON.parse(savedMemory);

          if (Array.isArray(parsed)) {
            memories = parsed;
          }

        }

      } catch (error) {

        console.error(
          "MEMORY READ ERROR:",
          error
        );

      }


      // ==========================================
      // 記憶削除
      // ==========================================

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


      // ==========================================
      // 「覚えて系」の発言を長期保存
      // ==========================================

      const shouldRemember =
        userMessage.includes("覚え") ||
        userMessage.includes("記憶して") ||
        userMessage.includes("忘れないで") ||
        userMessage.includes("忘れんで");


      if (shouldRemember) {

        const alreadyExists =
          memories.some(
            item =>
              item.text === userMessage
          );


        if (!alreadyExists) {

          memories.push({
            text: userMessage,
            savedAt:
              new Date().toISOString()
          });

        }


        // 最大50件
        memories =
          memories.slice(-50);


        try {

          await env.MEMORY.put(
            memoryKey,
            JSON.stringify(memories)
          );

          console.log(
            "MEMORY SAVED:",
            memoryKey,
            JSON.stringify(memories)
          );

        } catch (error) {

          console.error(
            "MEMORY WRITE ERROR:",
            error
          );

        }

      }


      // ==========================================
      // 会話履歴は直近16件
      // ==========================================

      history =
        history.slice(-16);


      const rememberedText =
        memories.length > 0
          ? memories
              .map(
                (item, i) =>
                  `${i + 1}. ${item.text}`
              )
              .join("\n")
          : "まだ特に覚えている情報はありません。";


      // ==========================================
      // AIへ渡す会話
      // ==========================================

      const messages = [

        {
          role: "system",

          content: `
あなたの名前は「ちゃぴ」。
LINEにいる、明るく親しみやすい博多の女の子です。

あなたは説明マシンではありません。
一番大事なのは、友達とのLINEのように自然に会話することです。

【絶対ルール】

・自然な博多弁で話す
・自分のことは「ちゃぴ」と呼ぶ
・「俺」は絶対に使わない
・関西弁は禁止

・雑談では勝手に長い解説を始めない

・相手の発言にまず自然に反応する

・基本は1〜4文程度

・LINEらしく短く返す

・質問された時だけ必要な説明をする

・過去の会話を踏まえて返す

・覚えている情報が関係する時は必ず活用する

・知らないことを適当に作らない

・同じ質問を何回も聞き返さない

・絵文字は軽く使ってよい


【使ってよい博多弁】

「〜ばい」
「〜たい」
「〜と？」
「〜しよーと？」
「〜けん」
「よかよ」
「知らん」
「ほんとと？」
「〜しとる」
「〜しよった」

ただし、
全部の文章に
「ばい」「たい」
を付けるのは禁止。

自然さを最優先してください。


【絶対に使わない関西弁】

「〜やん」
「〜やろ」
「〜やで」
「せや」
「ほんま」
「聞こえるで」
「〜してん」
「なんでやねん」


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
俺の好きな食べ物はカレーって覚えてて

ちゃぴ：
もちろん覚えとくばい🍛 カレー好きなんやね！


後でユーザー：
俺の好きな食べ物なんやった？

ちゃぴ：
カレーやろ〜🍛 ちゃんと覚えとるばい😂


【長期記憶】

${rememberedText}


長期記憶と会話履歴を必ず参考にして、
まず自然なLINE会話として返事してください。
`
        },


        ...history,


        {
          role: "user",
          content: userMessage
        }

      ];


      // ==========================================
      // Workers AI
      // ==========================================

      const aiResponse =
        await env.AI.run(

          "@cf/qwen/qwen3-30b-a3b-fp8",

          {
            messages,

            max_tokens: 220,

            temperature: 0.5,

            repetition_penalty: 1.1
          }

        );


      console.log(
        "AI RAW RESPONSE:",
        JSON.stringify(aiResponse)
      );


      const replyText =
        extractAIText(aiResponse) ||
        "ごめん、今うまく返事できんかった💦";


      // ==========================================
      // 会話履歴を保存
      // ==========================================

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

        console.error(
          "HISTORY WRITE ERROR:",
          error
        );

      }


      // ==========================================
      // LINEへ返信
      // ==========================================

      await replyToLine(
        event.replyToken,
        replyText,
        env
      );


    } catch (error) {

      console.error(
        "CHAPI EVENT ERROR:",
        error
      );

    }

  }

}


// ==============================================
// AIの返答形式を吸収
// ==============================================

function extractAIText(aiResponse) {

  if (!aiResponse) return "";


  const choiceContent =
    aiResponse
      ?.choices
      ?.[0]
      ?.message
      ?.content;


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

async function replyToLine(
  replyToken,
  text,
  env
) {

  const response =
    await fetch(

      "https://api.line.me/v2/bot/message/reply",

      {
        method: "POST",

        headers: {

          "Content-Type":
            "application/json",

          Authorization:
            `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`

        },

        body: JSON.stringify({

          replyToken,

          messages: [

            {
              type: "text",
              text:
                text.slice(0, 5000)
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


// ==============================================
// JSONテスト表示
// ==============================================

function jsonResponse(data) {

  return new Response(

    JSON.stringify(
      data,
      null,
      2
    ),

    {
      headers: {

        "Content-Type":
          "application/json; charset=UTF-8",

        "Cache-Control":
          "no-store"

      }
    }

  );

}
