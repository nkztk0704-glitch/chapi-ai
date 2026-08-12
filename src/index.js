export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ========================================================
    // Tavilyテスト
    // ========================================================
    if (
      request.method === "GET" &&
      url.searchParams.get("check") === "tavily"
    ) {
      try {
        const q =
          url.searchParams.get("q") ||
          "ダダサバイバー 今のイベント";

        const result = await searchTavily(q, "week", env);

        return jsonResponse({
          success: true,
          ...result,
        });
      } catch (error) {
        return jsonResponse({
          success: false,
          error: String(error),
        });
      }
    }

    // ========================================================
    // AIテスト
    // ========================================================
    if (
      request.method === "GET" &&
      url.searchParams.get("check") === "ai"
    ) {
      try {
        const aiResponse = await runAI(
          env,
          [
            {
              role: "system",
              content:
                "日本語で「AIテスト成功」とだけ答えてください。",
            },
            {
              role: "user",
              content: "テスト",
            },
          ],
          300,
          0.1
        );

        return jsonResponse({
          success: true,
          model: "@cf/qwen/qwen3-30b-a3b-fp8",
          extracted: extractAIText(aiResponse),
          rawResponse: aiResponse,
        });
      } catch (error) {
        return jsonResponse({
          success: false,
          error: String(error),
        });
      }
    }

    // ========================================================
    // 通常アクセス
    // ========================================================
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


// ============================================================
// LINEイベント
// ============================================================

async function handleEvents(events, env) {
  for (const event of events) {
    try {
      if (event.type !== "message") continue;
      if (event.message?.type !== "text") continue;

      const userMessage =
        String(event.message.text || "").trim();

      if (!userMessage) continue;

      const conversationId =
        event.source?.groupId ||
        event.source?.roomId ||
        event.source?.userId ||
        "default";

      const historyKey =
        `history:${conversationId}`;

      const memoryKey =
        `memory:${conversationId}`;

      // ======================================================
      // 履歴読み込み
      // ======================================================

      let history = [];

      try {
        const saved =
          await env.MEMORY.get(historyKey);

        if (saved) {
          const parsed = JSON.parse(saved);

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

      // ======================================================
      // 記憶読み込み
      // ======================================================

      let memories = [];

      try {
        const saved =
          await env.MEMORY.get(memoryKey);

        if (saved) {
          const parsed = JSON.parse(saved);

          if (Array.isArray(parsed)) {
            const migrated =
              migrateAllMemories(parsed);

            memories =
              migrated.memories;

            if (migrated.changed) {
              await env.MEMORY.put(
                memoryKey,
                JSON.stringify(memories)
              );
            }
          }
        }
      } catch (error) {
        console.error(
          "MEMORY READ ERROR:",
          error
        );
      }

      // ======================================================
      // 全部忘れる
      // ======================================================

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

      // ======================================================
      // 記憶登録
      // ======================================================

      const shouldRemember =
        userMessage.includes("覚え") ||
        userMessage.includes("記憶して") ||
        userMessage.includes("忘れないで") ||
        userMessage.includes("忘れんで");

      if (shouldRemember) {
        const newlySaved =
          extractMemories(userMessage);

        for (const item of newlySaved) {
          memories =
            upsertMemory(memories, item);
        }

        if (newlySaved.length > 0) {
          memories =
            memories.slice(-50);

          await env.MEMORY.put(
            memoryKey,
            JSON.stringify(memories)
          );

          const savedReply =
            buildSavedReply(newlySaved);

          if (savedReply) {
            await saveHistory(
              historyKey,
              history,
              userMessage,
              savedReply,
              env
            );

            await replyToLine(
              event.replyToken,
              savedReply,
              env
            );

            continue;
          }
        }
      }

      // ======================================================
      // 名前・呼び方
      // ======================================================

      const profileReply =
        buildExactProfileReply(
          userMessage,
          memories
        );

      if (profileReply) {
        await saveHistory(
          historyKey,
          history,
          userMessage,
          profileReply,
          env
        );

        await replyToLine(
          event.replyToken,
          profileReply,
          env
        );

        continue;
      }

      // ======================================================
      // 好きな食べ物
      // ======================================================

      const foodReply =
        buildExactFoodReply(
          userMessage,
          memories
        );

      if (foodReply) {
        await saveHistory(
          historyKey,
          history,
          userMessage,
          foodReply,
          env
        );

        await replyToLine(
          event.replyToken,
          foodReply,
          env
        );

        continue;
      }

      // ======================================================
      // Web検索判定
      // ======================================================

      const searchDecision =
        decideWhetherToSearch(userMessage);

      let searched = false;
      let searchAttempted = false;
      let webContext = "";
      let sourceUrls = [];

      if (searchDecision.search) {
        searchAttempted = true;

        try {
          const searchResult =
            await searchTavily(
              searchDecision.query,
              searchDecision.freshness,
              env
            );

          if (
            Array.isArray(searchResult.results) &&
            searchResult.results.length > 0
          ) {
            searched = true;

            webContext =
              searchResult.results
                .slice(0, 5)
                .map(
                  (item, index) => `
【検索資料 ${index + 1}】
タイトル:
${item.title}

内容:
${item.content}

URL:
${item.url}
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
            "SEARCH ERROR:",
            error
          );
        }
      }

      // ======================================================
      // 検索したのに0件
      // ======================================================

      if (
        searchAttempted &&
        !searched
      ) {
        const replyText =
          "ごめん、今うまく検索結果を確認できんかった💦 もう一回聞いてみて〜！";

        await saveHistory(
          historyKey,
          history,
          userMessage,
          replyText,
          env
        );

        await replyToLine(
          event.replyToken,
          replyText,
          env
        );

        continue;
      }

      // ======================================================
      // 普通の会話だけ記憶を渡す
      // ======================================================

      let memoryContext = "なし";
      let historyForAI = [];

      if (!searched) {
        const relevant =
          selectRelevantMemories(
            userMessage,
            memories
          );

        memoryContext =
          relevant.length
            ? relevant
                .map(memoryToText)
                .join("\n")
            : "なし";

        historyForAI =
          history.slice(-10);
      }

      // ======================================================
      // システムプロンプト
      // ======================================================

      const systemPrompt = `
あなたの名前は「ちゃぴ」です。

LINEで会話する、
明るく親しみやすい博多の女の子です。

【基本】
・自分のことは「ちゃぴ」と呼ぶ
・「俺」「僕」は絶対に使わない
・自然な博多弁
・友達とのLINEのように話す
・雑談は短め
・質問には結論から答える
・絵文字は少しだけ
・知らないことを作らない

【使ってよい表現】
〜ばい
〜たい
〜と？
〜けん
よかよ
〜しとる
〜しよった

【使わない表現】
やで
やん
せや
ほんま
なんでやねん
ええで
ええやろ
なんや
やったんや
あるんや
できるんや
なるんや

【Web検索について】

Web検索済みの場合は、
検索資料を最優先してください。

検索資料に書かれていない
発売日、価格、数字、イベント内容、
アップデート内容などを
勝手に作らないでください。

複数資料で内容が食い違う場合は、
断定せず
「情報が食い違っとる」
と伝えてください。

「最新」「今」「現在」
と聞かれた場合は、
古い情報を最新情報のように
説明しないでください。

検索資料の日付や内容から
現在確認できる情報を優先してください。

検索回答には、
過去の雑談やユーザーの個人情報を
勝手に混ぜないでください。

【ダダサバイバー】

検索資料に
「Survivor.io」
と書かれている場合、
日本語版の「ダダサバイバー」と
同じゲームを指す場合があります。

ただし資料にないイベント内容、
開催期間、報酬、性能などを
想像で追加しないでください。

【URL】

本文にはURLを書かないでください。
参考URLはプログラム側で追加します。

【Markdown禁止】

**
#
Markdownリンク

は使わないでください。

【長期記憶】

${memoryContext}

【Web検索状態】

${searched ? "Web検索済み" : "Web検索なし"}

【検索資料】

${webContext || "なし"}
`;

      const messages = [
        {
          role: "system",
          content: systemPrompt,
        },

        ...historyForAI,

        {
          role: "user",
          content: userMessage,
        },
      ];

      // ======================================================
      // AI
      // ======================================================

      let aiResponse;

      try {
        aiResponse =
          await runAI(
            env,
            messages,
            searched ? 900 : 600,
            searched ? 0.15 : 0.5
          );
      } catch (error) {
        console.error(
          "AI ERROR:",
          error
        );

        await replyToLine(
          event.replyToken,
          "ごめん、今AIの返事でエラーが出た💦 もう一回送ってみて〜！",
          env
        );

        continue;
      }

      let replyText =
        extractAIText(aiResponse);

      if (!replyText) {
        replyText =
          "ごめん、今うまく返事できんかった💦";
      }

      replyText =
        cleanReply(replyText);

      // ======================================================
      // 参考URL
      // ======================================================

      let lineReply = replyText;

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
              (url, index) =>
                `${index + 1}. ${url}`
            )
            .join("\n");
      }

      // ======================================================
      // 履歴保存
      // ======================================================

      await saveHistory(
        historyKey,
        history,
        userMessage,
        replyText,
        env
      );

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


// ============================================================
// AI実行
// ============================================================

async function runAI(
  env,
  messages,
  maxTokens = 600,
  temperature = 0.4
) {
  return await env.AI.run(
    "@cf/qwen/qwen3-30b-a3b-fp8",
    {
      messages,
      max_tokens: maxTokens,
      temperature,
      top_p: 0.85,
      repetition_penalty: 1.08,
    }
  );
}


// ============================================================
// 検索するか判定
// ============================================================

function decideWhetherToSearch(message) {
  const text =
    String(message || "").trim();

  const memoryWords = [
    "覚えてる",
    "覚えとる",
    "覚えてて",
    "好きな食べ物",
    "名前",
    "呼び方",
    "俺のこと",
    "私のこと",
  ];

  if (
    memoryWords.some(
      word => text.includes(word)
    )
  ) {
    return {
      search: false,
      query: "",
      freshness: "none",
    };
  }

  const searchWords = [
    "調べて",
    "検索して",
    "最新",
    "ニュース",
    "現在",
    "今来てる",
    "今きてる",
    "今やってる",
    "開催中",
    "今日",
    "価格",
    "値段",
    "発売",
    "アップデート",
    "イベント",
    "在庫",
    "結果",
    "順位",
    "営業時間",
    "天気",
  ];

  const shouldSearch =
    searchWords.some(
      word => text.includes(word)
    );

  if (!shouldSearch) {
    return {
      search: false,
      query: "",
      freshness: "none",
    };
  }

  let freshness = "none";

  if (
    text.includes("今日") ||
    text.includes("現在") ||
    text.includes("今来てる") ||
    text.includes("今きてる") ||
    text.includes("今やってる") ||
    text.includes("開催中")
  ) {
    freshness = "week";
  } else if (
    text.includes("最新") ||
    text.includes("最近") ||
    text.includes("ニュース")
  ) {
    freshness = "week";
  }

  return {
    search: true,
    query: buildSearchQuery(text),
    freshness,
  };
}


// ============================================================
// 検索語を作る
// ============================================================

function buildSearchQuery(text) {
  let query =
    String(text || "")
      .replace(/調べて教えて/g, " ")
      .replace(/調べて/g, " ")
      .replace(/検索して教えて/g, " ")
      .replace(/検索して/g, " ")
      .replace(/教えて/g, " ")
      .replace(/[？?！!]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  // ダダサバイバーは英語名も追加
  if (
    query.includes("ダダサバイバー") &&
    !query.toLowerCase().includes("survivor.io")
  ) {
    query += " Survivor.io";
  }

  return query.slice(0, 300);
}


// ============================================================
// Tavily検索
// ============================================================

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
    `tavily:v20:${simpleHash(
      `${query}:${freshness}`
    )}`;

  // ========================================================
  // キャッシュ
  // ========================================================

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
      "CACHE READ ERROR:",
      error
    );
  }

  let rawResults = [];

  // ========================================================
  // 1回目
  // 期間あり一般検索
  // ========================================================

  try {
    const first =
      await callTavily(
        query,
        freshness,
        env,
        []
      );

    rawResults =
      mergeResults(
        rawResults,
        first
      );
  } catch (error) {
    console.error(
      "TAVILY FIRST ERROR:",
      error
    );
  }

  // ========================================================
  // 2回目
  // ダダサバなら検索語を変えて追加検索
  // ========================================================

  if (
    isSurvivorQuery(query)
  ) {
    const extraQueries = [
      "Survivor.io latest event",
      "Survivor.io current event",
      "ダダサバイバー イベント 最新",
    ];

    for (const extraQuery of extraQueries) {
      try {
        const extra =
          await callTavily(
            extraQuery,
            freshness,
            env,
            []
          );

        rawResults =
          mergeResults(
            rawResults,
            extra
          );

        if (rawResults.length >= 8) {
          break;
        }
      } catch (error) {
        console.error(
          "SURVIVOR SEARCH ERROR:",
          error
        );
      }
    }
  }

  // ========================================================
  // 3回目
  // 少なければ期間制限なし
  // ========================================================

  if (rawResults.length < 3) {
    try {
      const retry =
        await callTavily(
          query,
          "none",
          env,
          []
        );

      rawResults =
        mergeResults(
          rawResults,
          retry
        );
    } catch (error) {
      console.error(
        "TAVILY RETRY ERROR:",
        error
      );
    }
  }

  // ========================================================
  // 結果整理
  //
  // 重要：
  // 日本語文章の完全一致率で
  // 結果を捨てない
  // ========================================================

  let results =
    rawResults
      .filter(isSafeSearchResult)
      .filter(
        item =>
          item?.title &&
          item?.url &&
          (
            typeof item.score !== "number" ||
            item.score >= 0.15
          )
      )
      .map(item => ({
        title:
          String(item.title || ""),

        url:
          String(item.url || ""),

        content:
          String(
            item.content || ""
          ).slice(0, 2200),

        score:
          typeof item.score === "number"
            ? item.score
            : 0,

        relevance:
          calculateRelevance(
            query,
            item
          ),

        trust:
          trustScore(item.url || ""),
      }))
      .sort(
        (a, b) => {
          const aTotal =
            a.score +
            a.relevance * 1.5 +
            a.trust;

          const bTotal =
            b.score +
            b.relevance * 1.5 +
            b.trust;

          return bTotal - aTotal;
        }
      );

  // ========================================================
  // ダダサバ検索では
  // Survivor.io関連を優先
  // ========================================================

  if (isSurvivorQuery(query)) {
    const survivorResults =
      results.filter(item =>
        isSurvivorResult(item)
      );

    if (survivorResults.length > 0) {
      const others =
        results.filter(
          item =>
            !isSurvivorResult(item)
        );

      results = [
        ...survivorResults,
        ...others,
      ];
    }
  }

  results =
    results
      .slice(0, 5)
      .map(item => ({
        title: item.title,
        url: item.url,
        content: item.content,
        score: item.score,
      }));

  const result = {
    query,
    results,
    searchedAt:
      new Date().toISOString(),
  };

  try {
    await env.MEMORY.put(
      cacheKey,
      JSON.stringify(result),
      {
        expirationTtl: 600,
      }
    );
  } catch (error) {
    console.error(
      "CACHE WRITE ERROR:",
      error
    );
  }

  return result;
}


// ============================================================
// Tavily API
// ============================================================

async function callTavily(
  query,
  freshness,
  env,
  includeDomains = []
) {
  const requestBody = {
    query,

    search_depth: "advanced",

    max_results: 10,

    include_answer: false,

    include_raw_content: false,

    include_images: false,

    exclude_domains: [
      "xvideos.com",
      "xhamster.com",
      "pornhub.com",
      "xnxx.com",
      "redtube.com",
      "youporn.com",
      "spankbang.com",
      "onlyfans.com",
    ],
  };

  if (
    Array.isArray(includeDomains) &&
    includeDomains.length > 0
  ) {
    requestBody.include_domains =
      includeDomains;
  }

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
            `Bearer ${env.TAVILY_API_KEY}`,
        },

        body:
          JSON.stringify(requestBody),
      }
    );

  const text =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `Tavily ${response.status}: ${text.slice(0, 500)}`
    );
  }

  const data =
    JSON.parse(text);

  return Array.isArray(data?.results)
    ? data.results
    : [];
}


// ============================================================
// ダダサバ判定
// ============================================================

function isSurvivorQuery(text) {
  const lower =
    String(text || "").toLowerCase();

  return (
    lower.includes("ダダサバ") ||
    lower.includes("survivor.io") ||
    lower.includes("survivor io")
  );
}


function isSurvivorResult(item) {
  const text =
    `${item?.title || ""} ${item?.content || ""}`
      .toLowerCase();

  return (
    text.includes("survivor.io") ||
    text.includes("survivor io") ||
    text.includes("ダダサバ")
  );
}


// ============================================================
// 関連度
// ============================================================

function calculateRelevance(
  query,
  item
) {
  const target =
    `${item?.title || ""} ${item?.content || ""}`
      .toLowerCase();

  const q =
    String(query || "")
      .toLowerCase();

  let score = 0;

  // ダダサバ
  if (
    isSurvivorQuery(q)
  ) {
    if (
      target.includes("survivor.io") ||
      target.includes("survivor io") ||
      target.includes("ダダサバ")
    ) {
      score += 4;
    }

    if (
      q.includes("イベント") &&
      (
        target.includes("event") ||
        target.includes("イベント")
      )
    ) {
      score += 2;
    }

    if (
      q.includes("装備") &&
      (
        target.includes("equipment") ||
        target.includes("gear") ||
        target.includes("装備")
      )
    ) {
      score += 2;
    }

    if (
      q.includes("サバイバー") &&
      (
        target.includes("survivor") ||
        target.includes("サバイバー")
      )
    ) {
      score += 1;
    }

    return score;
  }

  // その他の検索
  const keywords =
    extractSearchKeywords(q);

  for (const word of keywords) {
    if (
      target.includes(
        word.toLowerCase()
      )
    ) {
      score += 1;
    }
  }

  return score;
}


// ============================================================
// 日本語対応キーワード抽出
// ============================================================

function extractSearchKeywords(text) {
  const cleaned =
    String(text || "")
      .replace(
        /最新情報|最新|最近|調べて|検索して|教えて|について|とは|ニュース|現在|今日/g,
        " "
      )
      .replace(
        /[？?！!。、,.]/g,
        " "
      );

  const result = [];

  const english =
    cleaned.match(
      /[a-zA-Z0-9._-]{2,}/g
    ) || [];

  result.push(...english);

  const japanese =
    cleaned.match(
      /[ぁ-んァ-ヶ一-龠ー]{2,}/g
    ) || [];

  for (const chunk of japanese) {
    if (chunk.length <= 8) {
      result.push(chunk);
    } else {
      for (
        let i = 0;
        i < chunk.length - 1;
        i += 2
      ) {
        result.push(
          chunk.slice(i, i + 4)
        );
      }
    }
  }

  return [
    ...new Set(result),
  ].slice(0, 15);
}


// ============================================================
// 信頼度
// ============================================================

function trustScore(url) {
  const domain =
    getDomain(url);

  const official = [
    "nintendo.com",
    "nintendo.co.jp",
    "apple.com",
    "microsoft.com",
    "playstation.com",
  ];

  const trusted = [
    "famitsu.com",
    "gamewith.jp",
    "game8.jp",
    "4gamer.net",
    "automaton-media.com",
  ];

  if (
    official.some(
      item =>
        domain === item ||
        domain.endsWith(`.${item}`)
    )
  ) {
    return 3;
  }

  if (
    trusted.some(
      item =>
        domain === item ||
        domain.endsWith(`.${item}`)
    )
  ) {
    return 1.5;
  }

  return 0;
}


// ============================================================
// 安全
// ============================================================

function isSafeSearchResult(item) {
  const url =
    String(item?.url || "")
      .toLowerCase();

  const blocked = [
    "xvideos.",
    "xhamster.",
    "pornhub.",
    "xnxx.",
    "redtube.",
    "youporn.",
    "spankbang.",
    "onlyfans.",
  ];

  return !blocked.some(
    domain =>
      url.includes(domain)
  );
}


// ============================================================
// 検索結果統合
// ============================================================

function mergeResults(a, b) {
  const map =
    new Map();

  for (
    const item of [
      ...(a || []),
      ...(b || []),
    ]
  ) {
    if (!item?.url) continue;

    if (!map.has(item.url)) {
      map.set(
        item.url,
        item
      );
    }
  }

  return [
    ...map.values(),
  ];
}


// ============================================================
// 記憶抽出
// ============================================================

function extractMemories(text) {
  const result = [];

  const now =
    new Date().toISOString();

  const name =
    text.match(
      /(?:俺|私|僕)の名前は([^、。！!？?\s]+?)(?:って|と)?覚え/
    );

  if (name?.[1]) {
    result.push({
      type: "profile",
      key: "name",
      value:
        cleanMemoryValue(
          name[1]
        ),
      savedAt: now,
    });
  }

  const nickname =
    text.match(
      /呼び方は([^、。！!？?\s]+?)(?:でいい|でよい|にして|って)/
    );

  if (nickname?.[1]) {
    result.push({
      type: "profile",
      key: "nickname",
      value:
        cleanMemoryValue(
          nickname[1]
        ),
      savedAt: now,
    });
  }

  const food =
    text.match(
      /好きな食べ物(?:は|が)([^、。！!？?\n]+?)(?:って|と)?覚え/
    );

  if (food?.[1]) {
    result.push({
      type: "preference",
      key: "favorite_food",
      value:
        cleanFoodValue(
          food[1]
        ),
      savedAt: now,
    });
  }

  return result;
}


// ============================================================
// 古い記憶移行
// ============================================================

function migrateAllMemories(raw) {
  let result = [];
  let changed = false;

  for (const item of raw) {
    if (
      item?.key === "name" ||
      item?.key === "nickname" ||
      item?.key === "favorite_food"
    ) {
      result =
        upsertMemory(
          result,
          item
        );

      continue;
    }

    const text =
      String(
        item?.text ||
        item?.value ||
        item ||
        ""
      );

    const extracted =
      extractMemories(text);

    if (extracted.length > 0) {
      for (const converted of extracted) {
        result =
          upsertMemory(
            result,
            {
              ...converted,

              savedAt:
                item?.savedAt ||
                converted.savedAt,
            }
          );
      }

      changed = true;
    }
  }

  return {
    memories:
      result.slice(-50),

    changed,
  };
}


// ============================================================
// 記憶更新
// ============================================================

function upsertMemory(
  memories,
  item
) {
  const copy =
    [...memories];

  const index =
    copy.findIndex(
      current =>
        current.key === item.key
    );

  if (index >= 0) {
    copy[index] = item;
  } else {
    copy.push(item);
  }

  return copy;
}


// ============================================================
// 記憶した時の返事
// ============================================================

function buildSavedReply(items) {
  const name =
    items.find(
      item => item.key === "name"
    )?.value;

  const nickname =
    items.find(
      item => item.key === "nickname"
    )?.value;

  const food =
    items.find(
      item =>
        item.key === "favorite_food"
    )?.value;

  if (name && nickname) {
    return (
      `覚えたよ〜😊 名前は「${name}」、` +
      `呼ぶ時は「${nickname}」ね！`
    );
  }

  if (name) {
    return (
      `覚えたよ〜😊 名前は「${name}」ね！`
    );
  }

  if (nickname) {
    return (
      `了解👌 「${nickname}」って呼ぶね！`
    );
  }

  if (food) {
    return (
      `覚えたよ〜😊 好きな食べ物は「${food}」ね！`
    );
  }

  return "";
}


// ============================================================
// 名前回答
// ============================================================

function buildExactProfileReply(
  message,
  memories
) {
  const asksName =
    message.includes("名前");

  const asksNickname =
    message.includes("呼び");

  if (
    !asksName &&
    !asksNickname
  ) {
    return "";
  }

  const name =
    getMemory(
      memories,
      "name"
    );

  const nickname =
    getMemory(
      memories,
      "nickname"
    );

  if (
    asksName &&
    asksNickname &&
    name &&
    nickname
  ) {
    return (
      `名前は「${name}」で、` +
      `ちゃぴは「${nickname}」って呼ぶよ😊`
    );
  }

  if (
    asksName &&
    name
  ) {
    return (
      `名前は「${name}」ばい😊`
    );
  }

  if (
    asksNickname &&
    nickname
  ) {
    return (
      `「${nickname}」って呼ぶよ😊`
    );
  }

  return "";
}


// ============================================================
// 食べ物回答
// ============================================================

function buildExactFoodReply(
  message,
  memories
) {
  if (
    !message.includes(
      "好きな食べ物"
    )
  ) {
    return "";
  }

  const food =
    getMemory(
      memories,
      "favorite_food"
    );

  if (!food) {
    return (
      "好きな食べ物はまだ記憶できとらんみたい💦"
    );
  }

  return (
    `好きな食べ物は「${food}」ばい😊 ` +
    `ちゃんと覚えとるよ！`
  );
}


// ============================================================
// 記憶取得
// ============================================================

function getMemory(
  memories,
  key
) {
  const item =
    memories
      .filter(
        memory =>
          memory.key === key
      )
      .sort(
        (a, b) =>
          String(
            b.savedAt || ""
          ).localeCompare(
            String(
              a.savedAt || ""
            )
          )
      )[0];

  return item?.value || "";
}


// ============================================================
// 関連記憶
// ============================================================

function selectRelevantMemories(
  message,
  memories
) {
  if (
    message.includes("名前") ||
    message.includes("呼び")
  ) {
    return memories.filter(
      item =>
        item.key === "name" ||
        item.key === "nickname"
    );
  }

  if (
    message.includes("食べ物") ||
    message.includes("カレー")
  ) {
    return memories.filter(
      item =>
        item.key === "favorite_food"
    );
  }

  return [];
}


function memoryToText(item) {
  if (item.key === "name") {
    return `名前: ${item.value}`;
  }

  if (item.key === "nickname") {
    return `呼び方: ${item.value}`;
  }

  if (
    item.key === "favorite_food"
  ) {
    return (
      `好きな食べ物: ${item.value}`
    );
  }

  return "";
}


// ============================================================
// 記憶文字整形
// ============================================================

function cleanMemoryValue(value) {
  return String(value || "")
    .replace(/って.*$/g, "")
    .replace(/覚えて.*$/g, "")
    .replace(/でいい.*$/g, "")
    .trim();
}


function cleanFoodValue(value) {
  return String(value || "")
    .replace(/って.*$/g, "")
    .replace(/覚えて.*$/g, "")
    .trim();
}


// ============================================================
// AI返答取得
// ============================================================

function extractAIText(aiResponse) {
  if (!aiResponse) {
    return "";
  }

  const content =
    aiResponse
      ?.choices
      ?.[0]
      ?.message
      ?.content;

  if (
    typeof content === "string" &&
    content.trim()
  ) {
    return content.trim();
  }

  if (
    typeof aiResponse.response ===
      "string" &&
    aiResponse.response.trim()
  ) {
    return aiResponse.response.trim();
  }

  if (
    typeof aiResponse
      ?.result
      ?.response === "string"
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


// ============================================================
// 回答整形
// ============================================================

function cleanReply(text) {
  return String(text || "")
    .replace(/\*\*/g, "")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(
      /https?:\/\/[^\s]+/gi,
      ""
    )
    .replace(/ちゃび/g, "ちゃぴ")
    .replace(
      /やったんや/g,
      "やったとよ"
    )
    .replace(
      /できるんや/g,
      "できるとよ"
    )
    .replace(
      /あるんや/g,
      "あるとよ"
    )
    .replace(
      /なるんや/g,
      "なるとよ"
    )
    .replace(
      /みたいや/g,
      "みたい"
    )
    .replace(/やで/g, "ばい")
    .replace(/ほんま/g, "ほんと")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}


// ============================================================
// 履歴
// ============================================================

async function saveHistory(
  historyKey,
  history,
  userMessage,
  replyText,
  env
) {
  const updated = [
    ...history,

    {
      role: "user",
      content: userMessage,
    },

    {
      role: "assistant",
      content: replyText,
    },

  ].slice(-16);

  await env.MEMORY.put(
    historyKey,
    JSON.stringify(updated)
  );
}


// ============================================================
// ドメイン
// ============================================================

function getDomain(url) {
  try {
    return new URL(url)
      .hostname
      .toLowerCase();
  } catch {
    return "";
  }
}


// ============================================================
// ハッシュ
// ============================================================

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


// ============================================================
// LINE返信
// ============================================================

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
            `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
        },

        body:
          JSON.stringify({
            replyToken,

            messages: [
              {
                type: "text",

                text:
                  String(text)
                    .slice(0, 5000),
              },
            ],
          }),
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


// ============================================================
// JSON
// ============================================================

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
          "no-store",
      },
    }
  );
}
