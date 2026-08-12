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

      const userMessage = event.message.text.trim();

      const conversationId =
        event.source?.groupId ||
        event.source?.roomId ||
        event.source?.userId ||
        "default";

      const historyKey = `history:${conversationId}`;
      const memoryKey = `memory:${conversationId}`;

      // ==========================================
      // 会話履歴を読む
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
      // 長期記憶を読む
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
      // 記憶を全部削除
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
      // 「覚えて」と言われた内容を整理して保存
      // ==========================================

      const shouldRemember =
        userMessage.includes("覚え") ||
        userMessage.includes("記憶して") ||
        userMessage.includes("忘れないで") ||
        userMessage.includes("忘れんで");

      if (shouldRemember) {
        const extracted = extractMemories(userMessage);

        for (const newMemory of extracted) {
          memories = upsertMemory(
            memories,
            newMemory
          );
        }

        // 構造化できなかった場合も元文を保存
        if (extracted.length === 0) {
          memories = upsertMemory(
            memories,
            {
              type: "general",
              key: normalizeMemoryKey(userMessage),
              value: userMessage,
              text: userMessage,
              savedAt: new Date().toISOString()
            }
          );
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

      // ==========================================
      // 履歴は直近16件
      // ==========================================

      history = history.slice(-16);

      // ==========================================
      // 今回の発言に関係ある記憶だけ選ぶ
      // ==========================================

      const relevantMemories =
        selectRelevantMemories(
          userMessage,
          memories
        );

      const relevantMemoryText =
        relevantMemories.length > 0
          ? relevantMemories
              .map(
                (item, i) =>
                  `${i + 1}. ${memoryToText(item)}`
              )
              .join("\n")
          : "今回の会話に関係する長期記憶はありません。";

      // ==========================================
      // 検索要否判定
      // ==========================================

      const searchDecision =
        decideWhetherToSearch(userMessage);

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

          if (searchResult.results.length > 0) {
            searched = true;

            webContext =
              searchResult.results
                .map(
                  (item, index) => `
【検索資料 ${index + 1}】
タイトル:
${item.title}

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
                .map(item => item.url)
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
      // 検索時は過去の古いAI回答を使わない
      // ==========================================

      let historyForAI = history;

      if (searchDecision.search) {
        historyForAI =
          history
            .filter(item => item.role === "user")
            .slice(-4);
      }

      // ==========================================
      // AIシステムプロンプト
      // ==========================================

      const systemPrompt = `
あなたの名前は「ちゃぴ」。

LINEにいる、明るく親しみやすい博多の女の子として、
友達とのLINEのように自然に会話してください。

━━━━━━━━━━━━━━━━━━
【キャラクター】
━━━━━━━━━━━━━━━━━━

・名前は必ず「ちゃぴ」
・自分のことも「ちゃぴ」
・「俺」「僕」は絶対に使わない
・明るく親しみやすく話す
・説明マシンのようにならない
・絵文字は少しだけ自然に使う

━━━━━━━━━━━━━━━━━━
【話し方】
━━━━━━━━━━━━━━━━━━

自然な博多弁で話してください。

使ってよい例：

「〜ばい」
「〜たい」
「〜と？」
「〜けん」
「よかよ」
「〜しとる」
「〜しよった」

ただし、毎文に方言を付ける必要はありません。

関西弁になるくらいなら標準語を使ってください。

━━━━━━━━━━━━━━━━━━
【絶対禁止の関西弁】
━━━━━━━━━━━━━━━━━━

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
【長期記憶の使い方】
━━━━━━━━━━━━━━━━━━

下に表示される長期記憶は、
今回の会話に関係すると判断された情報だけです。

重要：

・表示されていない長期記憶を勝手に思い出したように話さない
・今回の話題と関係ない記憶を持ち出さない
・名前の話をしている時に食べ物の話を突然出さない
・食べ物の話をしている時に名前の説明を突然しない
・記憶は必要な時だけ自然に使う

━━━━━━━━━━━━━━━━━━
【Web検索】
━━━━━━━━━━━━━━━━━━

Web検索済みの場合は、
あなたの古い知識や過去のAI回答より
今回の検索資料を優先してください。

検索資料に書かれていない事実を作ってはいけません。

特に、

・価格
・発売日
・日付
・数字
・仕様
・イベント日時
・発表内容

は資料で確認できる場合だけ答えてください。

検索資料が0件の場合は、
最新情報を知ったふりをせず、

「今うまく検索結果を確認できんかった」

などと正直に伝えてください。

回答本文にURLは書かないでください。
URLはシステム側で最後に追加します。

━━━━━━━━━━━━━━━━━━
【Markdown禁止】
━━━━━━━━━━━━━━━━━━

LINEなので、

**
#
[文字](URL)

などのMarkdown記法は使わないでください。

━━━━━━━━━━━━━━━━━━
【今回使ってよい長期記憶】
━━━━━━━━━━━━━━━━━━

${relevantMemoryText}

━━━━━━━━━━━━━━━━━━
【今回のWeb検索状態】
━━━━━━━━━━━━━━━━━━

${searched ? "Web検索済み" : "Web検索なし"}

━━━━━━━━━━━━━━━━━━
【今回の検索資料】
━━━━━━━━━━━━━━━━━━

${webContext || "なし"}
`;

      // ==========================================
      // AIへ問い合わせ
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
            repetition_penalty: 1.1
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
// 覚えて系メッセージから記憶を構造化
// ==============================================

function extractMemories(text) {
  const results = [];
  const now = new Date().toISOString();

  // 名前
  const nameMatch =
    text.match(
      /(?:俺|私|僕)?の?名前(?:は|が)?[「『]?([^、。！!？?\s]+)[」』]?(?:って)?/
    );

  if (nameMatch?.[1]) {
    results.push({
      type: "profile",
      key: "name",
      value: nameMatch[1],
      text: `名前は${nameMatch[1]}`,
      savedAt: now
    });
  }

  // 呼び方
  const nicknameMatch =
    text.match(
      /(?:呼び方|呼ぶ時|呼ぶなら)(?:は|を)?[「『]?([^、。！!？?\s]+)[」』]?(?:で|って|と)/
    );

  if (nicknameMatch?.[1]) {
    results.push({
      type: "profile",
      key: "nickname",
      value: nicknameMatch[1],
      text: `呼び方は${nicknameMatch[1]}`,
      savedAt: now
    });
  }

  // 「〇〇って呼んで」
  const callMeMatch =
    text.match(
      /[「『]?([^、。！!？?\s]+)[」』]?(?:って|と)呼んで/
    );

  if (
    callMeMatch?.[1] &&
    !results.some(
      item => item.key === "nickname"
    )
  ) {
    results.push({
      type: "profile",
      key: "nickname",
      value: callMeMatch[1],
      text: `呼び方は${callMeMatch[1]}`,
      savedAt: now
    });
  }

  // 好きな食べ物
  const foodMatch =
    text.match(
      /好きな食べ物(?:は|が)?[「『]?([^、。！!？?]+?)[」』]?(?:って|と)?(?:覚え|記憶|忘れ)/
    );

  if (foodMatch?.[1]) {
    results.push({
      type: "preference",
      key: "favorite_food",
      value: foodMatch[1].trim(),
      text: `好きな食べ物は${foodMatch[1].trim()}`,
      savedAt: now
    });
  }

  // 好きな〇〇
  const favoriteMatch =
    text.match(
      /好きな([^はが、。！!？?\s]+)(?:は|が)?[「『]?([^、。！!？?]+?)[」』]?(?:って|と)?(?:覚え|記憶|忘れ)/
    );

  if (
    favoriteMatch?.[1] &&
    favoriteMatch?.[2] &&
    favoriteMatch[1] !== "食べ物"
  ) {
    const category =
      favoriteMatch[1].trim();

    const value =
      favoriteMatch[2].trim();

    results.push({
      type: "preference",
      key: `favorite_${category}`,
      value,
      text: `好きな${category}は${value}`,
      savedAt: now
    });
  }

  return results;
}


// ==============================================
// 同じ種類の記憶は更新
// ==============================================

function upsertMemory(
  memories,
  newMemory
) {
  const normalized =
    memories.map(
      normalizeLegacyMemory
    );

  const index =
    normalized.findIndex(
      item =>
        item.key === newMemory.key
    );

  if (index >= 0) {
    normalized[index] =
      newMemory;
  } else {
    normalized.push(
      newMemory
    );
  }

  return normalized;
}


// ==============================================
// 旧形式の記憶も使えるよう変換
// ==============================================

function normalizeLegacyMemory(item) {
  if (
    item &&
    typeof item === "object" &&
    item.key
  ) {
    return item;
  }

  const text =
    typeof item === "string"
      ? item
      : String(
          item?.text || ""
        );

  const lower =
    text.toLowerCase();

  if (
    text.includes("名前")
  ) {
    return {
      type: "profile",
      key: "name_legacy",
      value: text,
      text,
      savedAt:
        item?.savedAt || ""
    };
  }

  if (
    text.includes("呼び方") ||
    text.includes("呼んで")
  ) {
    return {
      type: "profile",
      key: "nickname_legacy",
      value: text,
      text,
      savedAt:
        item?.savedAt || ""
    };
  }

  if (
    text.includes("好きな食べ物") ||
    text.includes("カレー")
  ) {
    return {
      type: "preference",
      key: "favorite_food_legacy",
      value: text,
      text,
      savedAt:
        item?.savedAt || ""
    };
  }

  return {
    type: "general",
    key:
      normalizeMemoryKey(text),
    value: text,
    text,
    savedAt:
      item?.savedAt || ""
  };
}


// ==============================================
// 今回必要な記憶だけ選択
// ==============================================

function selectRelevantMemories(
  message,
  memories
) {
  const text =
    message.toLowerCase();

  const normalized =
    memories.map(
      normalizeLegacyMemory
    );

  // 名前・呼び方
  if (
    text.includes("名前") ||
    text.includes("呼び方") ||
    text.includes("呼んで") ||
    text.includes("なんて呼")
  ) {
    return normalized
      .filter(
        item =>
          item.key === "name" ||
          item.key === "nickname" ||
          item.key === "name_legacy" ||
          item.key === "nickname_legacy"
      )
      .slice(-5);
  }

  // 食べ物
  if (
    text.includes("食べ物") ||
    text.includes("食べる") ||
    text.includes("料理") ||
    text.includes("カレー")
  ) {
    return normalized
      .filter(
        item =>
          String(item.key)
            .includes("favorite_food")
      )
      .slice(-5);
  }

  // 好きなもの全般
  if (
    text.includes("好き") ||
    text.includes("お気に入り")
  ) {
    return normalized
      .filter(
        item =>
          item.type === "preference"
      )
      .slice(-5);
  }

  // 「俺のこと覚えとる？」のような質問
  if (
    text.includes("俺のこと") ||
    text.includes("私のこと") ||
    text.includes("覚えとる") ||
    text.includes("覚えてる")
  ) {
    return normalized
      .filter(
        item =>
          item.type === "profile"
      )
      .slice(-5);
  }

  // 一般会話では無理に長期記憶を渡さない
  return [];
}


// ==============================================
// 記憶表示用
// ==============================================

function memoryToText(item) {
  if (item?.text) {
    return item.text;
  }

  if (
    item?.key &&
    item?.value
  ) {
    return `${item.key}: ${item.value}`;
  }

  return String(item || "");
}


// ==============================================
// 記憶キー生成
// ==============================================

function normalizeMemoryKey(text) {
  return (
    "general_" +
    simpleHash(
      String(text || "")
    )
  );
}


// ==============================================
// 検索要否判定
// ==============================================

function decideWhetherToSearch(message) {
  const text =
    message.trim();

  // 記憶関連は検索しない
  const memoryWords = [
    "覚えてる",
    "覚えとる",
    "覚えてて",
    "好きな食べ物",
    "名前",
    "呼び方",
    "前に言った",
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

  // 明確な雑談は検索しない
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
      word => text === word
    )
  ) {
    return {
      search: false,
      query: "",
      freshness: "none"
    };
  }

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
// 検索語整理
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
    `tavily:v6:${simpleHash(
      `${query}:${freshness}`
    )}`;

  // 15分キャッシュ
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
      "TAVILY CACHE READ ERROR:",
      error
    );
  }

  let rawResults =
    await callTavily(
      query,
      freshness,
      env
    );

  // 期間指定で弱い時だけ期間なし再検索
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
    search_depth: "basic",
    max_results: 8,
    include_answer: false,
    include_raw_content: false,
    include_images: false
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
        method: "POST",

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
// 検索結果結合
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
// 公式・一次情報優先
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
// 検索キーワード抽出
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
// ドメイン取得
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
// LINE回答クリーニング
// ==============================================

function cleanReply(text) {
  let cleaned =
    String(text || "");

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

  cleaned =
    cleaned.replace(
      /https?:\/\/[^\s]+/gi,
      ""
    );

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
// ブラウザテスト
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
