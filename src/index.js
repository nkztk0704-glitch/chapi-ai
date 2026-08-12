export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ==========================================
    // Tavily単体テスト
    // ==========================================
    if (
      request.method === "GET" &&
      url.searchParams.get("check") === "tavily"
    ) {
      try {
        const result = await searchTavily(
          "Nintendo Switch 2 最新情報",
          "week",
          env
        );

        return jsonResponse({
          success: true,
          ...result
        });

      } catch (error) {
        return jsonResponse({
          success: false,
          error: String(error)
        });
      }
    }

    // ==========================================
    // 通常のLINE Webhook
    // ==========================================
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

    // LINEにはすぐ200を返す
    ctx.waitUntil(handleEvents(events, env));

    return new Response("OK");
  },
};


// ==============================================
// LINEイベント処理
// ==============================================

async function handleEvents(events, env) {
  for (const event of events) {
    try {
      if (event.type !== "message") continue;
      if (event.message?.type !== "text") continue;

      const userMessage =
        event.message.text.trim();

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
        const saved =
          await env.MEMORY.get(historyKey);

        if (saved) {
          const parsed =
            JSON.parse(saved);

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
        const saved =
          await env.MEMORY.get(memoryKey);

        if (saved) {
          const parsed =
            JSON.parse(saved);

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
      // 長期記憶保存
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

        memories =
          memories.slice(-50);

        try {
          await env.MEMORY.put(
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
      // 検索するか判定
      // ==========================================
      const searchDecision =
        decideWhetherToSearch(
          userMessage
        );

      let webContext = "";
      let sourceUrls = [];
      let searched = false;


      // ==========================================
      // Tavily検索
      // ==========================================
      if (searchDecision.search) {
        try {
          const searchResult =
            await searchTavily(
              searchDecision.query,
              searchDecision.freshness,
              env
            );

          if (
            searchResult.results.length > 0
          ) {
            searched = true;

            webContext =
              searchResult.results
                .slice(0, 5)
                .map(
                  (item, index) => `
【検索資料 ${index + 1}】
タイトル: ${item.title}
内容: ${item.content}
関連度: ${item.score}
`
                )
                .join("\n");

            sourceUrls =
              searchResult.results
                .slice(0, 3)
                .map(
                  item => item.url
                )
                .filter(Boolean);
          }

        } catch (error) {
          console.error(
            "TAVILY SEARCH ERROR:",
            error
          );
        }
      }


      // ==========================================
      // AIへ渡すメッセージ
      // ==========================================
      const messages = [
        {
          role: "system",

          content: `
あなたの名前は「ちゃぴ」。
LINEにいる、明るく親しみやすい博多の女の子です。

友達とのLINEのように自然に会話してください。

【絶対ルール】

・自然な博多弁で話す
・自分のことは必ず「ちゃぴ」と呼ぶ
・「俺」「僕」は使わない
・関西弁は禁止
・雑談では長い説明をしない
・質問にはまず結論から答える
・会話履歴と長期記憶を参考にする
・知らないことを作らない
・絵文字は自然な範囲で少し使う

【自然な博多弁】

「〜ばい」
「〜たい」
「〜と？」
「〜けん」
「よかよ」
「〜しとる」
「〜しよった」

毎文に方言を入れる必要はありません。

関西弁になるくらいなら標準語で話してください。

【禁止する関西弁】

「〜やで」
「〜やん」
「せや」
「ほんま」
「ええやろ」
「ええで」
「なんでやねん」
「できるんや」
「あるんや」
「なるんや」

【Web検索について】

Web検索済みの場合は、
下の検索資料を最新情報の根拠として使ってください。

重要：

・検索資料にない事実を作らない
・資料にない価格を作らない
・資料にない発売日を作らない
・資料にない数字を作らない
・古い知識より検索資料を優先する
・複数資料が食い違う場合は断定しない
・質問と関係ない資料は無視する
・検索結果がなかった場合は最新情報を知ったふりしない

Web検索をしたのに有効な資料が0件だった場合は、

「今うまく検索結果を確認できんかった」

のように正直に伝えてください。

回答本文にはURLを書かないでください。

「参考」
「出典」
「リンクはこちら」

なども書かないでください。

URLはシステム側で最後に追加します。

【長期記憶】

${rememberedText}

【Web検索状況】

${searched ? "Web検索済み" : "Web検索なし"}

【検索資料】

${webContext || "なし"}
`
        },

        ...history,

        {
          role: "user",
          content: userMessage
        }
      ];


      // ==========================================
      // メインAI
      // ==========================================
      const aiResponse =
        await env.AI.run(
          "@cf/qwen/qwen3-30b-a3b-fp8",
          {
            messages,
            max_tokens: 550,
            temperature: 0.35,
            repetition_penalty: 1.1
          }
        );


      let replyText =
        extractAIText(aiResponse) ||
        "ごめん、今うまく返事できんかった💦";


      // ==========================================
      // 最低限の方言補正
      // ==========================================
      replyText =
        cleanDialect(replyText);


      // ==========================================
      // LINE表示用だけ参考URL追加
      // ==========================================
      let lineReply =
        replyText;

      if (
        sourceUrls.length > 0
      ) {
        const uniqueUrls =
          [...new Set(sourceUrls)];

        lineReply +=
          "\n\n🔎 参考\n" +
          uniqueUrls
            .map(
              (url, i) =>
                `${i + 1}. ${url}`
            )
            .join("\n");
      }


      // ==========================================
      // 会話履歴保存
      // URLは履歴に保存しない
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
      // LINE返信
      // ==========================================
      await replyToLine(
        event.replyToken,
        lineReply,
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
// 検索要否判定
// ==============================================

function decideWhetherToSearch(message) {
  const text =
    message.trim();


  // ==========================================
  // 記憶系は検索しない
  // ==========================================
  const memoryWords = [
    "覚えてる",
    "覚えとる",
    "覚えてて",
    "好きな食べ物",
    "前に言った",
    "前言った",
    "さっき言った",
    "俺のこと",
    "私のこと"
  ];

  if (
    memoryWords.some(
      word =>
        text.includes(word)
    )
  ) {
    return {
      search: false,
      query: "",
      freshness: "none"
    };
  }


  // ==========================================
  // 雑談で検索しないパターン
  // ==========================================
  const casualPatterns = [
    "今日暑いね",
    "今日暑いな",
    "暑いね",
    "暑いな",
    "眠い",
    "疲れた",
    "おはよう",
    "こんにちは",
    "こんばんは",
    "おやすみ",
    "暇",
    "ひま"
  ];

  if (
    casualPatterns.some(
      word =>
        text === word
    )
  ) {
    return {
      search: false,
      query: "",
      freshness: "none"
    };
  }


  // ==========================================
  // 明示的に検索が必要
  // ==========================================
  const searchWords = [
    "調べて",
    "検索して",
    "最新",
    "ニュース",
    "現在",
    "今の",
    "今日の",
    "価格",
    "値段",
    "発売",
    "アップデート",
    "イベント",
    "在庫",
    "どこで買",
    "今売って",
    "結果",
    "順位"
  ];

  const shouldSearch =
    searchWords.some(
      word =>
        text.includes(word)
    );


  if (!shouldSearch) {
    return {
      search: false,
      query: "",
      freshness: "none"
    };
  }


  let freshness =
    "none";

  if (
    text.includes("今日の") ||
    text.includes("現在")
  ) {
    freshness =
      "day";

  } else if (
    text.includes("最新") ||
    text.includes("最近") ||
    text.includes("ニュース")
  ) {
    freshness =
      "week";
  }


  return {
    search: true,
    query:
      text.slice(0, 350),
    freshness
  };
}


// ==============================================
// Tavily検索
// ==============================================

async function searchTavily(
  query,
  freshness,
  env
) {
  if (!env.TAVILY_API_KEY) {
    throw new Error(
      "TAVILY_API_KEY が設定されていません"
    );
  }


  const cacheKey =
    `tavily:${simpleHash(
      `${query}:${freshness}`
    )}`;


  // ==========================================
  // 15分キャッシュ
  // ==========================================
  try {
    const cached =
      await env.MEMORY.get(
        cacheKey
      );

    if (cached) {
      const parsed =
        JSON.parse(cached);

      if (
        parsed &&
        Array.isArray(
          parsed.results
        )
      ) {
        console.log(
          "TAVILY CACHE HIT:",
          query
        );

        return parsed;
      }
    }

  } catch (error) {
    console.error(
      "TAVILY CACHE READ ERROR:",
      error
    );
  }


  // ==========================================
  // 1回目
  // 最新系なら期間指定あり
  // ==========================================
  let rawResults =
    await callTavily(
      query,
      freshness,
      env
    );


  // ==========================================
  // 期間指定で0件だった場合だけ
  // 期間指定なしで1回再検索
  // ==========================================
  if (
    rawResults.length === 0 &&
    freshness !== "none"
  ) {
    console.log(
      "TAVILY RETRY WITHOUT TIME RANGE:",
      query
    );

    rawResults =
      await callTavily(
        query,
        "none",
        env
      );
  }


  // ==========================================
  // 危険サイト除外
  // ==========================================
  const safeResults =
    rawResults
      .filter(
        item =>
          isSafeSearchResult(
            item
          )
      )
      .map(
        item => ({
          title:
            String(
              item.title || ""
            ),

          url:
            String(
              item.url || ""
            ),

          content:
            String(
              item.content || ""
            ).slice(
              0,
              1800
            ),

          score:
            typeof item.score === "number"
              ? item.score
              : 0
        })
      )
      .filter(
        item =>
          item.title &&
          item.url &&
          item.score >= 0.20
      )
      .sort(
        (a, b) => {
          const trustDifference =
            trustedBoost(
              b.url
            ) -
            trustedBoost(
              a.url
            );

          if (
            trustDifference !== 0
          ) {
            return trustDifference;
          }

          return (
            b.score -
            a.score
          );
        }
      )
      .slice(0, 5);


  const result = {
    query,
    results:
      safeResults,
    searchedAt:
      new Date().toISOString()
  };


  // ==========================================
  // 15分保存
  // ==========================================
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
      "TAVILY CACHE WRITE ERROR:",
      error
    );
  }


  return result;
}


// ==============================================
// Tavily API実行
// ==============================================

async function callTavily(
  query,
  freshness,
  env
) {
  const requestBody = {
    query,

    search_depth:
      "basic",

    max_results:
      7,

    include_answer:
      false,

    include_raw_content:
      false,

    include_images:
      false
  };


  // ==========================================
  // 最新系だけ期間指定
  // ==========================================
  if (
    freshness === "day" ||
    freshness === "week" ||
    freshness === "month"
  ) {
    requestBody.time_range =
      freshness;
  }


  const response =
    await fetch(
      "https://api.tavily.com/search",
      {
        method:
          "POST",

        headers: {
          "Content-Type":
            "application/json",

          Authorization:
            `Bearer ${env.TAVILY_API_KEY}`
        },

        body:
          JSON.stringify(
            requestBody
          )
      }
    );


  const text =
    await response.text();


  if (!response.ok) {
    throw new Error(
      `Tavily ${response.status}: ${text.slice(0, 500)}`
    );
  }


  let data;

  try {
    data =
      JSON.parse(text);

  } catch {
    throw new Error(
      "Tavily returned invalid JSON"
    );
  }


  return Array.isArray(
    data?.results
  )
    ? data.results
    : [];
}


// ==============================================
// 危険・成人向けサイト除外
// ==============================================

function isSafeSearchResult(item) {
  const url =
    String(
      item?.url || ""
    ).toLowerCase();

  const text =
    `${item?.title || ""} ${item?.content || ""}`
      .toLowerCase();


  const blockedDomains = [
    "xvideos.",
    "xhamster.",
    "pornhub.",
    "xnxx.",
    "redtube.",
    "youporn.",
    "spankbang.",
    "tube8.",
    "onlyfans.",
    "brazzers."
  ];


  if (
    blockedDomains.some(
      domain =>
        url.includes(domain)
    )
  ) {
    return false;
  }


  const blockedWords = [
    "porn",
    "porno",
    "ポルノ",
    "アダルト動画",
    "18禁動画"
  ];


  if (
    blockedWords.some(
      word =>
        text.includes(word)
    )
  ) {
    return false;
  }


  return true;
}


// ==============================================
// 公式ドメインを少し優先
// ==============================================

function trustedBoost(url) {
  const domain =
    String(url || "")
      .toLowerCase();


  const officialDomains = [
    ".go.jp",
    ".lg.jp",

    "nintendo.com",
    "nintendo.co.jp",

    "sony.com",
    "playstation.com",

    "apple.com",

    "google.com",

    "microsoft.com",

    "support.google.com",

    "support.apple.com"
  ];


  return officialDomains.some(
    trusted =>
      domain.includes(
        trusted
      )
  )
    ? 1
    : 0;
}


// ==============================================
// 関西弁・誤字の最低限補正
// ==============================================

function cleanDialect(text) {
  return String(
    text || ""
  )
    .replace(
      /ちゃび/g,
      "ちゃぴ"
    )
    .replace(
      /やで[〜～]?/g,
      "ばい"
    )
    .replace(
      /ええで[〜～]?/g,
      "よかよ"
    )
    .replace(
      /ええやろ[〜～]?/g,
      "よかろ〜"
    )
    .replace(
      /ほんま/g,
      "ほんと"
    )
    .trim();
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
// AI返答取り出し
// ==============================================

function extractAIText(
  aiResponse
) {
  if (!aiResponse) {
    return "";
  }


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
    return (
      aiResponse.response.trim()
    );
  }


  if (
    typeof aiResponse
      ?.result
      ?.response === "string" &&
    aiResponse
      .result
      .response
      .trim()
  ) {
    return (
      aiResponse
        .result
        .response
        .trim()
    );
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
        method:
          "POST",

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
                type:
                  "text",

                text:
                  text.slice(
                    0,
                    5000
                  )
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
// ブラウザテスト表示
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
