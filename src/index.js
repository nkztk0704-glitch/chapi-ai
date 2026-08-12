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

      // ==========================================
      // 会話履歴
      // ==========================================
      let history = [];

      try {
        const saved = await env.MEMORY.get(historyKey);

        if (saved) {
          const parsed = JSON.parse(saved);
          if (Array.isArray(parsed)) history = parsed;
        }
      } catch (error) {
        console.error("HISTORY READ ERROR:", error);
      }


      // ==========================================
      // 長期記憶
      // ==========================================
      let memories = [];

      try {
        const saved = await env.MEMORY.get(memoryKey);

        if (saved) {
          const parsed = JSON.parse(saved);
          if (Array.isArray(parsed)) memories = parsed;
        }
      } catch (error) {
        console.error("MEMORY READ ERROR:", error);
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
          "わかったよ👌 今まで覚えとったことは全部消したばい！",
          env
        );

        continue;
      }


      // ==========================================
      // 長期記憶保存
      // ==========================================
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


      // ==========================================
      // 検索判定
      // ==========================================
      const searchDecision = await decideSearch(
        userMessage,
        history,
        env
      );

      console.log(
        "SEARCH DECISION:",
        JSON.stringify(searchDecision)
      );

      let webContext = "";
      let sourceUrls = [];
      let searched = false;


      // ==========================================
      // Web検索
      // ==========================================
      if (searchDecision.search) {
        try {
          const searchResult = await searchWeb(
            searchDecision.query || userMessage,
            searchDecision.freshness,
            env
          );

          if (searchResult.results.length > 0) {
            searched = true;

            webContext = searchResult.results
              .slice(0, 6)
              .map((item, index) => `
【資料${index + 1}】
タイトル: ${item.title}
概要: ${item.description}
更新日: ${item.updatedAt || "不明"}
`)
              .join("\n");

            sourceUrls = searchResult.results
              .slice(0, 3)
              .map(item => item.link)
              .filter(Boolean);
          }

        } catch (error) {
          console.error("WEB SEARCH ERROR:", error);
        }
      }


      // ==========================================
      // メインAI
      // ==========================================
      const messages = [
        {
          role: "system",
          content: `
あなたの名前は「ちゃぴ」です。

LINEにいる明るく親しみやすい女の子として、
友達とLINEしているように自然に会話してください。

━━━━━━━━━━━━━━━━━━
【キャラクター】
━━━━━━━━━━━━━━━━━━

・名前は必ず「ちゃぴ」
・自分を「ちゃび」「俺」「僕」と呼ばない
・自然な博多弁
・明るく親しみやすい
・説明マシンのように話さない

━━━━━━━━━━━━━━━━━━
【博多弁】
━━━━━━━━━━━━━━━━━━

自然な範囲で、

「〜ばい」
「〜たい」
「〜と？」
「〜けん」
「よかよ」
「〜しとる」
「〜しよった」
「〜やね」
「〜なん？」

などを使ってください。

ただし毎文方言にする必要はありません。

関西弁になるくらいなら標準語を使ってください。

━━━━━━━━━━━━━━━━━━
【絶対禁止の関西弁】
━━━━━━━━━━━━━━━━━━

以下の表現は絶対に使用しません。

「やで」
「やん」
「せや」
「ほんま」
「なんでやねん」
「ええやろ」
「ええで」
「できるんや」
「あるんや」
「なるんや」
「なんや」
「〜へん」
「〜してん」
「〜やろ〜」

━━━━━━━━━━━━━━━━━━
【会話】
━━━━━━━━━━━━━━━━━━

雑談：
1〜4文程度で自然に返します。

質問：
まず結論を答えてから必要な説明をします。

・同じ質問を繰り返さない
・長期記憶を必要な時に使う
・過去の会話を参考にする
・知らないことを作らない
・絵文字は少しだけ使う

━━━━━━━━━━━━━━━━━━
【Web検索をした場合】
━━━━━━━━━━━━━━━━━━

Web検索結果は「資料」です。

資料に書かれている事実だけを使ってください。

重要：

・資料にない価格を作らない
・資料にない発売日を作らない
・資料にない仕様を作らない
・推測を事実として書かない
・分からない場合は「確認できんかった」と言う
・公式情報があれば優先する
・質問と無関係な結果は無視する
・古い情報を「最新」と呼ばない

「最新情報」と質問された場合は、

単なる製品説明ではなく、
検索結果の中から最近追加・発表・更新された内容を優先してください。

検索結果に最近の情報が確認できない場合は、

「検索結果から新しい発表までは確認できんかった」

など正直に伝えてください。

━━━━━━━━━━━━━━━━━━
【URLについて】
━━━━━━━━━━━━━━━━━━

回答本文に、

URL
リンク
参考サイト一覧
「参考：」
「出典：」

を書いてはいけません。

参考URLはシステムが回答の最後に自動追加します。

━━━━━━━━━━━━━━━━━━
【長期記憶】
━━━━━━━━━━━━━━━━━━

${rememberedText}

━━━━━━━━━━━━━━━━━━
【Web検索状況】
━━━━━━━━━━━━━━━━━━

${searched ? "Web検索済み" : "Web検索なし"}

━━━━━━━━━━━━━━━━━━
【検索資料】
━━━━━━━━━━━━━━━━━━

${webContext || "なし"}
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
          max_tokens: 700,
          temperature: 0.3,
          repetition_penalty: 1.1
        }
      );


      let replyText =
        extractAIText(aiResponse) ||
        "ごめん、今うまく返事できんかった💦";


      // ==========================================
      // 必ず最終品質チェック
      // ==========================================
      try {
        replyText = await finalCheck(
          replyText,
          userMessage,
          searched,
          webContext,
          env
        );
      } catch (error) {
        console.error("FINAL CHECK ERROR:", error);
      }


      // ==========================================
      // 万一残ったURL等を除去
      // ==========================================
      replyText = cleanReply(replyText);


      // ==========================================
      // LINE表示用
      // ==========================================
      let lineReply = replyText;

      if (sourceUrls.length > 0) {
        const uniqueUrls = [...new Set(sourceUrls)];

        lineReply +=
          "\n\n🔎 参考\n" +
          uniqueUrls
            .map((url, i) => `${i + 1}. ${url}`)
            .join("\n");
      }


      // ==========================================
      // 履歴には本文だけ保存
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
        console.error("HISTORY WRITE ERROR:", error);
      }


      await replyToLine(
        event.replyToken,
        lineReply,
        env
      );

    } catch (error) {
      console.error("CHAPI EVENT ERROR:", error);
    }
  }
}


// ==============================================
// 検索要否判定
// ==============================================
async function decideSearch(userMessage, history, env) {
  try {
    const recentHistory = history
      .slice(-4)
      .map(item => `${item.role}: ${item.content}`)
      .join("\n");

    const response = await env.AI.run(
      "@cf/meta/llama-3.2-3b-instruct",
      {
        messages: [
          {
            role: "system",
            content: `
Web検索が必要か判断してください。

search=true：

・最新情報
・現在の情報
・今日の情報
・ニュース
・価格
・発売状況
・現在開催中イベント
・ゲームの最新環境
・アップデート
・現在のサービス仕様
・「調べて」
・「検索して」
・変化しやすい情報

search=false：

・挨拶
・雑談
・相談
・感想
・長期記憶
・過去の会話
・時期に左右されない一般知識

freshness：

day = 今日
week = 最新・最近
month = 今月
none = 指定不要

必ずJSONのみ。

{"search":true,"query":"検索語","freshness":"week"}

または

{"search":false,"query":"","freshness":"none"}
`
          },

          {
            role: "user",
            content: `
直近：
${recentHistory}

今回：
${userMessage}
`
          }
        ],

        max_tokens: 100,
        temperature: 0.1
      }
    );


    const text = extractAIText(response);

    const match =
      text.match(/\{[\s\S]*\}/);

    if (match) {
      const parsed =
        JSON.parse(match[0]);

      return {
        search:
          parsed.search === true,

        query:
          typeof parsed.query === "string"
            ? parsed.query.trim()
            : "",

        freshness:
          ["day", "week", "month", "none"]
            .includes(parsed.freshness)
            ? parsed.freshness
            : "none"
      };
    }

  } catch (error) {
    console.error(
      "SEARCH DECISION ERROR:",
      error
    );
  }


  const words = [
    "最新",
    "現在",
    "ニュース",
    "価格",
    "発売",
    "イベント",
    "アップデート",
    "検索して",
    "調べて"
  ];

  const shouldSearch =
    words.some(word =>
      userMessage.includes(word)
    );


  return {
    search: shouldSearch,
    query:
      shouldSearch
        ? userMessage
        : "",
    freshness:
      userMessage.includes("今日")
        ? "day"
        : userMessage.includes("最新")
          ? "week"
          : "none"
  };
}


// ==============================================
// Web検索
// ==============================================
async function searchWeb(
  query,
  freshness,
  env
) {

  const cacheKey =
    `search:${simpleHash(
      `${query}:${freshness}`
    )}`;


  try {
    const cached =
      await env.MEMORY.get(cacheKey);

    if (cached) {
      const parsed =
        JSON.parse(cached);

      if (
        parsed &&
        Array.isArray(parsed.results)
      ) {
        return parsed;
      }
    }

  } catch (error) {
    console.error(
      "SEARCH CACHE READ ERROR:",
      error
    );
  }


  if (!env.SERPAPI_API_KEY) {
    throw new Error(
      "SERPAPI_API_KEY is missing"
    );
  }


  const url = new URL(
    "https://serpapi.org/api/v1/webs-search"
  );

  url.searchParams.set(
    "keyword",
    query
  );

  url.searchParams.set(
    "gl",
    "JP"
  );

  url.searchParams.set(
    "hl",
    "ja"
  );

  url.searchParams.set(
    "size",
    "8"
  );


  if (freshness === "day") {
    url.searchParams.set("time", "d");
  }

  if (freshness === "week") {
    url.searchParams.set("time", "w");
  }

  if (freshness === "month") {
    url.searchParams.set("time", "m");
  }


  url.searchParams.set(
    "token",
    env.SERPAPI_API_KEY
  );


  const response =
    await fetch(url.toString());

  const text =
    await response.text();


  if (!response.ok) {
    throw new Error(
      `Search API ${response.status}: ${text.slice(0, 300)}`
    );
  }


  let payload;

  try {
    payload =
      JSON.parse(text);
  } catch {
    throw new Error(
      "Search API returned invalid JSON"
    );
  }


  let items = [];

  if (
    Array.isArray(payload?.data)
  ) {
    items = payload.data;

  } else if (
    Array.isArray(
      payload?.data?.items
    )
  ) {
    items =
      payload.data.items;
  }


  const results = items
    .filter(
      item =>
        item &&
        item.title &&
        (item.link || item.url)
    )
    .slice(0, 8)
    .map(item => ({
      title:
        String(
          item.title || ""
        ),

      link:
        String(
          item.link ||
          item.url ||
          ""
        ),

      description:
        String(
          item.description ||
          item.desc ||
          item.snippet ||
          ""
        ),

      updatedAt:
        String(
          item.updated_at ||
          item.published_at ||
          item.date ||
          ""
        )
    }));


  const result = {
    query,
    freshness,
    results,
    searchedAt:
      new Date().toISOString()
  };


  try {
    await env.MEMORY.put(
      cacheKey,
      JSON.stringify(result),
      {
        expirationTtl: 900
      }
    );

  } catch (error) {
    console.error(
      "SEARCH CACHE WRITE ERROR:",
      error
    );
  }


  return result;
}


// ==============================================
// 最終品質チェック
// ==============================================
async function finalCheck(
  text,
  userMessage,
  searched,
  webContext,
  env
) {

  const response = await env.AI.run(
    "@cf/meta/llama-3.2-3b-instruct",
    {
      messages: [
        {
          role: "system",
          content: `
あなたはLINE AI「ちゃぴ」の最終編集者です。

元回答をチェックし、
必要な場合だけ修正してください。

【絶対条件】

名前：
「ちゃぴ」

自称：
「ちゃぴ」

自然な博多弁の女の子。

関西弁は禁止。

禁止表現：

やで
やん
せや
ほんま
なんでやねん
ええやろ
ええで
なんや
できるんや
あるんや
なるんや
〜へん
〜してん

これらがあれば必ず自然な博多弁か標準語へ直してください。

「ちゃび」など名前の誤字は
「ちゃぴ」に直してください。

【自然さ】

元回答の意味を不必要に変えません。

雑談は短く自然にします。

質問への回答は、
結論が分かる文章にします。

【Web検索済みの場合】

検索資料に存在しない具体的な事実を
勝手に追加してはいけません。

特に、

価格
発売日
日付
数字
仕様
発表内容

は資料で確認できないなら断定禁止です。

元回答に根拠のない断定があれば削除してください。

【URL】

URLや参考サイト一覧はすべて削除してください。

「参考：」
「出典：」

なども不要です。

システムが後で自動追加します。

【重要】

説明や採点は返さないでください。

完成したLINE返信本文だけ返してください。
`
        },

        {
          role: "user",
          content: `
ユーザー発言：
${userMessage}

Web検索済み：
${searched ? "はい" : "いいえ"}

検索資料：
${searched ? webContext : "なし"}

元回答：
${text}
`
        }
      ],

      max_tokens: 700,
      temperature: 0.15
    }
  );


  return (
    extractAIText(response) ||
    text
  );
}


// ==============================================
// URL等を機械的に除去
// ==============================================
function cleanReply(text) {

  let cleaned = text;

  // URL除去
  cleaned = cleaned.replace(
    /https?:\/\/[^\s]+/gi,
    ""
  );

  // 参考・出典だけの行を除去
  cleaned = cleaned
    .split("\n")
    .filter(line => {
      const trimmed =
        line.trim();

      if (
        /^参考[:：]?$/.test(trimmed) ||
        /^出典[:：]?$/.test(trimmed) ||
        /^参考サイト[:：]?$/.test(trimmed)
      ) {
        return false;
      }

      return true;
    })
    .join("\n");

  // 念のため代表的な関西弁を機械的補正
  cleaned = cleaned
    .replace(/やで[〜～]?/g, "ばい")
    .replace(/ええやろ[〜～]?/g, "よかろ〜")
    .replace(/ええで[〜～]?/g, "よかよ")
    .replace(/ほんま/g, "ほんと")
    .replace(/せやな/g, "そうやね")
    .replace(/ちゃび/g, "ちゃぴ");

  return cleaned.trim();
}


// ==============================================
// 簡易ハッシュ
// ==============================================
function simpleHash(text) {

  let hash =
    2166136261;

  for (
    let i = 0;
    i < text.length;
    i++
  ) {

    hash ^=
      text.charCodeAt(i);

    hash +=
      (hash << 1) +
      (hash << 4) +
      (hash << 7) +
      (hash << 8) +
      (hash << 24);
  }

  return (
    hash >>> 0
  ).toString(16);
}


// ==============================================
// AI返答取得
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

        body:
          JSON.stringify({
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
