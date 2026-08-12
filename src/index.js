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
    // 通常のLINE webhook
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

          if (Array.isArray(parsed)) {
            history = parsed;
          }
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

          if (Array.isArray(parsed)) {
            memories = parsed;
          }
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
      // Web検索するか判断
      // ==========================================
      const searchDecision =
        decideWhetherToSearch(userMessage);

      let webContext = "";
      let sourceUrls = [];
      let searched = false;

      if (searchDecision.search) {
        try {
          const searchResult = await searchTavily(
            searchDecision.query,
            searchDecision.freshness,
            env
          );

          if (searchResult.results.length > 0) {
            searched = true;

            webContext = searchResult.results
              .slice(0, 5)
              .map((item, index) => `
【検索資料 ${index + 1}】
タイトル: ${item.title}
内容: ${item.content}
関連度: ${item.score}
`)
              .join("\n");

            sourceUrls = searchResult.results
              .slice(0, 3)
              .map(item => item.url)
              .filter(Boolean);
          }
        } catch (error) {
          console.error("TAVILY SEARCH ERROR:", error);
        }
      }

      // ==========================================
      // AIへ渡す内容
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
・自分のことは「ちゃぴ」と呼ぶ
・「俺」「僕」は使わない
・関西弁は禁止
・雑談では長い説明を始めない
・質問にはまず結論から答える
・会話履歴と長期記憶を参考にする
・知らないことを作らない
・絵文字は少しだけ自然に使う

【使ってよい博多弁】
「〜ばい」
「〜たい」
「〜と？」
「〜けん」
「よかよ」
「〜しとる」
「〜しよった」

毎文方言にする必要はありません。
関西弁になるくらいなら標準語にしてください。

【禁止】
「〜やで」
「〜やん」
「せや」
「ほんま」
「ええやろ」
「ええで」
「なんでやねん」
「できるんや」
「あるんや」

【Web検索について】

今回Web検索をした場合、
下の「検索資料」だけを最新情報の根拠として使ってください。

重要：
・検索資料と関係ないことを作らない
・資料にない価格や発売日を作らない
・資料にない数字を作らない
・複数資料で食い違う場合は断定しない
・質問と無関係な資料は無視する
・最新情報は古い知識より検索資料を優先する
・検索できなかった場合、最新情報を知ったふりしない
・回答本文にURLや「参考」「出典」を書かない
・URLはシステム側で最後に付けます

【長期記憶】
${rememberedText}

【Web検索】
${searched ? "実行済み" : "今回は検索していません"}

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

      const aiResponse = await env.AI.run(
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
      // 最低限の関西弁補正
      // ==========================================
      replyText = cleanDialect(replyText);

      // ==========================================
      // LINE表示用だけURL追加
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
// 検索するか判断
// ==============================================
function decideWhetherToSearch(message) {
  const text = message.trim();

  // 記憶・会話系は検索しない
  const memoryWords = [
    "覚えてる",
    "覚えとる",
    "好きな食べ物",
    "前に言った",
    "さっき言った",
    "俺の",
    "私の"
  ];

  if (
    memoryWords.some(word => text.includes(word))
  ) {
    return {
      search: false,
      query: "",
      freshness: "none"
    };
  }

  // 明示的に検索してほしい場合
  const explicitSearchWords = [
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
    "おすすめ",
    "どこで買",
    "在庫"
  ];

  const explicit =
    explicitSearchWords.some(
      word => text.includes(word)
    );

  // 明確な質問文
  const looksLikeQuestion =
    text.includes("?") ||
    text.includes("？") ||
    text.endsWith("教えて") ||
    text.includes("いつ") ||
    text.includes("どこ") ||
    text.includes("誰") ||
    text.includes("何が") ||
    text.includes("何？") ||
    text.includes("どれ");

  const shouldSearch =
    explicit || looksLikeQuestion;

  let freshness = "none";

  if (
    text.includes("今日") ||
    text.includes("現在")
  ) {
    freshness = "day";
  } else if (
    text.includes("最新") ||
    text.includes("最近") ||
    text.includes("ニュース")
  ) {
    freshness = "week";
  }

  return {
    search: shouldSearch,
    query: shouldSearch
      ? text.slice(0, 350)
      : "",
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
      await env.MEMORY.get(cacheKey);

    if (cached) {
      const parsed =
        JSON.parse(cached);

      if (
        parsed &&
        Array.isArray(parsed.results)
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

  const body = {
    query,
    search_depth: "basic",
    max_results: 7,
    include_answer: false,
    include_raw_content: false,
    include_images: false,
    country: "japan"
  };

  if (
    freshness === "day" ||
    freshness === "week" ||
    freshness === "month"
  ) {
    body.time_range = freshness;
  }

  const response = await fetch(
    "https://api.tavily.com/search",
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json",

        Authorization:
          `Bearer ${env.TAVILY_API_KEY}`
      },

      body:
        JSON.stringify(body)
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
    data = JSON.parse(text);
  } catch {
    throw new Error(
      "Tavily returned invalid JSON"
    );
  }

  const rawResults =
    Array.isArray(data?.results)
      ? data.results
      : [];

  // ==========================================
  // 危険・無関係結果を除外
  // ==========================================
  const safeResults =
    rawResults
      .filter(item =>
        isSafeSearchResult(item)
      )
      .filter(item =>
        isRelevantResult(
          query,
          item
        )
      )
      .map(item => ({
        title:
          String(item.title || ""),

        url:
          String(item.url || ""),

        content:
          String(item.content || "")
            .slice(0, 1800),

        score:
          typeof item.score === "number"
            ? item.score
            : 0
      }))
      .sort(
        (a, b) =>
          trustedBoost(b.url) -
            trustedBoost(a.url) ||
          b.score - a.score
      )
      .slice(0, 5);

  // ==========================================
  // 関連性が低すぎる場合は全破棄
  // ==========================================
  const finalResults =
    safeResults.length > 0 &&
    safeResults[0].score >= 0.45
      ? safeResults
      : [];

  const result = {
    query,
    results: finalResults,
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
      "TAVILY CACHE WRITE ERROR:",
      error
    );
  }

  return result;
}


// ==============================================
// 成人向け・危険ドメイン除外
// ==============================================
function isSafeSearchResult(item) {
  const url =
    String(item?.url || "")
      .toLowerCase();

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
    "onlyfans."
  ];

  if (
    blockedDomains.some(
      domain => url.includes(domain)
    )
  ) {
    return false;
  }

  const blockedWords = [
    "porn",
    "porno",
    "ポルノ",
    "アダルト動画"
  ];

  if (
    blockedWords.some(
      word => text.includes(word)
    )
  ) {
    return false;
  }

  return true;
}


// ==============================================
// 質問と検索結果の関連性確認
// ==============================================
function isRelevantResult(
  query,
  item
) {
  const score =
    typeof item?.score === "number"
      ? item.score
      : 0;

  // Tavilyの関連度が十分高ければ採用
  if (score >= 0.65) {
    return true;
  }

  const queryWords =
    extractKeywords(query);

  if (queryWords.length === 0) {
    return score >= 0.45;
  }

  const target =
    `${item?.title || ""} ${item?.content || ""} ${item?.url || ""}`
      .toLowerCase();

  const matches =
    queryWords.filter(
      word =>
        target.includes(
          word.toLowerCase()
        )
    ).length;

  return (
    matches >= 1 &&
    score >= 0.4
  );
}


// ==============================================
// 検索語からキーワード抽出
// ==============================================
function extractKeywords(text) {
  const cleaned =
    text
      .replace(/[？?！!。、,.]/g, " ")
      .replace(
        /(最新情報|最新|調べて|検索して|教えて|について|とは|現在|今日|ニュース)/g,
        " "
      );

  return cleaned
    .split(/\s+/)
    .map(word => word.trim())
    .filter(word => word.length >= 2)
    .slice(0, 8);
}


// ==============================================
// 信頼度を軽く優先
// ==============================================
function trustedBoost(url) {
  const domain =
    String(url || "")
      .toLowerCase();

  const trusted = [
    ".go.jp",
    ".lg.jp",
    "nintendo.com",
    "nintendo.co.jp",
    "apple.com",
    "google.com",
    "microsoft.com",
    "sony.com",
    "playstation.com"
  ];

  return trusted.some(
    item => domain.includes(item)
  )
    ? 1
    : 0;
}


// ==============================================
// 関西弁の最低限補正
// ==============================================
function cleanDialect(text) {
  return String(text || "")
    .replace(/ちゃび/g, "ちゃぴ")
    .replace(/やで[〜～]?/g, "ばい")
    .replace(/ええで[〜～]?/g, "よかよ")
    .replace(/ええやろ[〜～]?/g, "よかろ〜")
    .replace(/ほんま/g, "ほんと")
    .trim();
}


// ==============================================
// 簡易ハッシュ
// ==============================================
function simpleHash(text) {
  let hash = 2166136261;

  for (
    let i = 0;
    i < text.length;
    i++
  ) {
    hash ^= text.charCodeAt(i);

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
  const response = await fetch(
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
// テスト表示
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
