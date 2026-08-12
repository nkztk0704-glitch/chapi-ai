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
    // 通常アクセス
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

    ctx.waitUntil(
      handleEvents(events, env)
    );

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
      // 会話履歴
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
      // 長期記憶
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
      // 全記憶削除
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
      // 検索要否判定
      // ==========================================

      const searchDecision =
        decideWhetherToSearch(
          userMessage
        );


      let searched = false;
      let webContext = "";
      let sourceUrls = [];


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
                .map(
                  (item, index) => `
【検索資料 ${index + 1}】

タイトル:
${item.title}

URL:
${item.url}

内容:
${item.content}

関連度:
${item.score}
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
      // 検索質問では古いAI回答を混ぜない
      // ==========================================

      let historyForAI = history;

      if (searchDecision.search) {
        historyForAI =
          history
            .filter(
              item =>
                item.role === "user"
            )
            .slice(-4);
      }


      // ==========================================
      // AIシステムプロンプト
      // ==========================================

      const systemPrompt = `
あなたの名前は「ちゃぴ」。

LINEにいる、
明るく親しみやすい博多の女の子として
自然に会話してください。


━━━━━━━━━━━━━━━━━━
【キャラクター】
━━━━━━━━━━━━━━━━━━

・名前は必ず「ちゃぴ」
・自分のことも「ちゃぴ」
・「俺」「僕」は絶対に使わない
・友達とのLINEのように話す
・説明マシンのようにならない
・絵文字は少しだけ自然に使う


━━━━━━━━━━━━━━━━━━
【話し方】
━━━━━━━━━━━━━━━━━━

自然な博多弁を使ってください。

使ってよい例：

「〜ばい」
「〜たい」
「〜と？」
「〜けん」
「よかよ」
「〜しとる」
「〜しよった」
「〜やね」

毎文に方言を付ける必要はありません。

関西弁になるくらいなら
標準語を使ってください。


━━━━━━━━━━━━━━━━━━
【絶対禁止の関西弁】
━━━━━━━━━━━━━━━━━━

以下は絶対に使わないでください。

「やで」
「やん」
「せや」
「ほんま」
「なんでやねん」
「ええで」
「ええやろ」
「できるんや」
「あるんや」
「なるんや」
「みたいや」
「なんや」
「〜へん」


━━━━━━━━━━━━━━━━━━
【会話ルール】
━━━━━━━━━━━━━━━━━━

雑談：
短く自然に返す。

質問：
最初に答えを言って、
必要な説明を続ける。

・知らないことを作らない
・同じ質問を繰り返さない
・長期記憶は必要な時だけ使う
・ユーザーの言葉をそのまま真似しすぎない


━━━━━━━━━━━━━━━━━━
【Web検索に関する最重要ルール】
━━━━━━━━━━━━━━━━━━

Web検索済みの場合、

あなたの古い知識や
過去のAI回答より、

今回の検索資料を
必ず優先してください。


検索資料に現在存在している商品・サービス・出来事が
書かれている場合、

「まだ発表されていない」
「存在しない」
「発売されていない」

など、
検索資料と矛盾する回答をしてはいけません。


Web検索済みの場合は、

検索資料から確認できる事実だけを使って
回答してください。


特に以下は勝手に作ってはいけません。

・発売日
・価格
・人数
・数字
・仕様
・イベント日時
・サービス内容
・発表内容


資料同士で食い違う場合は、

「情報が食い違っとる」

などと正直に伝えてください。


検索資料が0件なら、

「今うまく検索結果を確認できんかった」

と伝えてください。


━━━━━━━━━━━━━━━━━━
【最新情報について】
━━━━━━━━━━━━━━━━━━

ユーザーが
「最新情報」
「最近」
「今」
などを聞いた場合、

単なる基本スペック説明ではなく、

検索資料の中から、

・最近更新された内容
・新しく発表された内容
・現在利用できる内容

を優先してください。


━━━━━━━━━━━━━━━━━━
【URLについて】
━━━━━━━━━━━━━━━━━━

回答本文にはURLを書かないでください。

以下も書かないでください。

「参考」
「出典」
「公式サイトはこちら」
「リンクはこちら」

URLはシステムが後で自動追加します。


━━━━━━━━━━━━━━━━━━
【Markdown禁止】
━━━━━━━━━━━━━━━━━━

LINEなので、

**太字**
# 見出し
Markdownリンク

などのMarkdown記法は使わないでください。


━━━━━━━━━━━━━━━━━━
【長期記憶】
━━━━━━━━━━━━━━━━━━

${rememberedText}


━━━━━━━━━━━━━━━━━━
【今回の検索状態】
━━━━━━━━━━━━━━━━━━

${searched ? "Web検索済み" : "Web検索なし"}


━━━━━━━━━━━━━━━━━━
【今回の検索資料】
━━━━━━━━━━━━━━━━━━

${webContext || "なし"}
`;


      // ==========================================
      // AIメッセージ
      // ==========================================

      const messages = [
        {
          role: "system",
          content: systemPrompt
        },

        ...historyForAI,

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

            max_tokens: 650,

            temperature:
              searched
                ? 0.2
                : 0.4,

            repetition_penalty:
              1.1
          }
        );


      let replyText =
        extractAIText(aiResponse) ||
        "ごめん、今うまく返事できんかった💦";


      // ==========================================
      // LINE用クリーニング
      // ==========================================

      replyText =
        cleanReply(replyText);


      // ==========================================
      // LINE表示用だけ参考URL追加
      // ==========================================

      let lineReply =
        replyText;


      if (
        searched &&
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
      // 履歴保存
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
  // 記憶系
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
  // 雑談
  // ==========================================

  const casualPatterns = [
    "暑いね",
    "暑いな",
    "今日暑いね",
    "今日暑いな",
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
  // Web検索が必要な表現
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
    "順位",
    "営業時間",
    "天気"
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
      cleanSearchQuery(text),

    freshness
  };
}


// ==============================================
// 検索語を軽く整える
// ==============================================

function cleanSearchQuery(text) {
  return String(text)
    .replace(
      /調べて(教えて)?/g,
      ""
    )
    .replace(
      /検索して(教えて)?/g,
      ""
    )
    .trim()
    .slice(0, 300);
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
    `tavily:v5:${simpleHash(
      `${query}:${freshness}`
    )}`;


  // ==========================================
  // KVキャッシュ
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
  // Tavily呼び出し
  // ==========================================

  let rawResults =
    await callTavily(
      query,
      freshness,
      env
    );


  // ==========================================
  // 期間指定で弱い時は通常検索
  // ==========================================

  if (
    rawResults.length < 3 &&
    freshness !== "none"
  ) {
    const retry =
      await callTavily(
        query,
        "none",
        env
      );

    rawResults =
      mergeResults(
        rawResults,
        retry
      );
  }


  // ==========================================
  // 安全フィルター
  // ==========================================

  const safeResults =
    rawResults
      .filter(
        item =>
          isSafeSearchResult(item)
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
              2200
            ),

          score:
            typeof item.score === "number"
              ? item.score
              : 0,

          trust:
            trustedBoost(
              item.url || ""
            ),

          relevance:
            keywordOverlap(
              query,
              `${item.title || ""} ${item.content || ""}`
            )
        })
      )
      .filter(
        item =>
          item.title &&
          item.url &&
          item.score >= 0.20
      );


  // ==========================================
  // 順位付け
  // ==========================================

  safeResults.sort(
    (a, b) => {
      const aTotal =
        a.trust * 2 +
        a.relevance +
        a.score;

      const bTotal =
        b.trust * 2 +
        b.relevance +
        b.score;

      return (
        bTotal -
        aTotal
      );
    }
  );


  // ==========================================
  // 同一ドメインを増やしすぎない
  // ==========================================

  const selected = [];
  const domainCounts =
    new Map();


  for (
    const item of safeResults
  ) {
    const domain =
      getDomain(item.url);

    const current =
      domainCounts.get(domain) || 0;


    if (current >= 2) {
      continue;
    }


    selected.push(item);

    domainCounts.set(
      domain,
      current + 1
    );


    if (
      selected.length >= 5
    ) {
      break;
    }
  }


  const results =
    selected.map(
      item => ({
        title:
          item.title,

        url:
          item.url,

        content:
          item.content,

        score:
          item.score
      })
    );


  const result = {
    query,
    results,
    searchedAt:
      new Date().toISOString()
  };


  // ==========================================
  // 15分キャッシュ
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
// Tavily API
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
      8,

    include_answer:
      false,

    include_raw_content:
      false,

    include_images:
      false
  };


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
// 検索結果を重複排除して結合
// ==============================================

function mergeResults(a, b) {
  const map =
    new Map();


  for (
    const item of [
      ...a,
      ...b
    ]
  ) {
    if (!item?.url) {
      continue;
    }

    if (
      !map.has(item.url)
    ) {
      map.set(
        item.url,
        item
      );
    }
  }


  return [
    ...map.values()
  ];
}


// ==============================================
// 危険サイト除外
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
    "brazzers.",
    "adult."
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
// 公式・一次情報を優先
// ==============================================

function trustedBoost(url) {
  const domain =
    getDomain(url);


  const officialDomains = [
    "nintendo.com",
    "nintendo.co.jp",
    "support.nintendo.com",
    "sony.com",
    "playstation.com",
    "apple.com",
    "support.apple.com",
    "google.com",
    "support.google.com",
    "microsoft.com",
    "support.microsoft.com",
    "github.com",
    "developers.cloudflare.com",
    "cloudflare.com",
    ".go.jp",
    ".lg.jp"
  ];


  return officialDomains.some(
    item =>
      domain.includes(item)
  )
    ? 1
    : 0;
}


// ==============================================
// 質問との関連度
// ==============================================

function keywordOverlap(
  query,
  target
) {
  const words =
    extractKeywords(query);


  if (
    words.length === 0
  ) {
    return 0;
  }


  const normalizedTarget =
    String(target)
      .toLowerCase();


  const matched =
    words.filter(
      word =>
        normalizedTarget.includes(
          word.toLowerCase()
        )
    ).length;


  return (
    matched /
    words.length
  );
}


// ==============================================
// キーワード抽出
// ==============================================

function extractKeywords(text) {
  return String(text)
    .replace(
      /[？?！!。、,.]/g,
      " "
    )
    .replace(
      /(最新情報|最新|最近|調べて|検索して|教えて|について|とは|ニュース|現在|今日)/g,
      " "
    )
    .split(/\s+/)
    .map(
      word =>
        word.trim()
    )
    .filter(
      word =>
        word.length >= 2
    )
    .slice(
      0,
      10
    );
}


// ==============================================
// URLからドメイン取得
// ==============================================

function getDomain(url) {
  try {
    return new URL(url)
      .hostname
      .toLowerCase();

  } catch {
    return "";
  }
}


// ==============================================
// 最終回答クリーニング
// ==============================================

function cleanReply(text) {
  let cleaned =
    String(text || "");


  // Markdown除去
  cleaned =
    cleaned
      .replace(
        /\*\*/g,
        ""
      )
      .replace(
        /^#{1,6}\s*/gm,
        ""
      );


  // URL除去
  cleaned =
    cleaned.replace(
      /https?:\/\/[^\s]+/gi,
      ""
    );


  // 参考・出典だけの行除去
  cleaned =
    cleaned
      .split("\n")
      .filter(
        line => {
          const value =
            line.trim();

          return !(
            /^参考[:：]?$/.test(value) ||
            /^出典[:：]?$/.test(value) ||
            /^リンク[:：]?$/.test(value)
          );
        }
      )
      .join("\n");


  // 代表的な関西弁補正
  cleaned =
    cleaned
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
        "よかよ"
      )
      .replace(
        /ほんま/g,
        "ほんと"
      )
      .replace(
        /みたいや/g,
        "みたい"
      )
      .replace(
        /なんや/g,
        "なん"
      );


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
