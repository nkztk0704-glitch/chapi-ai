export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ============================================================
    // AI単体テスト
    // ============================================================
    if (
      request.method === "GET" &&
      url.searchParams.get("check") === "ai"
    ) {
      try {
        const aiResponse = await runAI(
          [
            {
              role: "system",
              content:
                "あなたは日本語で短く答えるAIです。思考過程は出力せず、最終回答だけ返してください。",
            },
            {
              role: "user",
              content:
                "「AIテスト成功」とだけ答えてください。",
            },
          ],
          env,
          {
            maxTokens: 512,
            temperature: 0.1,
          }
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

    // ============================================================
    // Tavily単体テスト
    // ============================================================
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
          ...result,
        });
      } catch (error) {
        return jsonResponse({
          success: false,
          error: String(error),
        });
      }
    }

    // ============================================================
    // 通常アクセス
    // ============================================================
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
// LINEイベント処理
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

      // ============================================================
      // 会話履歴
      // ============================================================

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

      // ============================================================
      // 長期記憶
      // ============================================================

      let memories = [];

      try {
        const saved =
          await env.MEMORY.get(memoryKey);

        if (saved) {
          const parsed =
            JSON.parse(saved);

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

      // ============================================================
      // 全記憶削除
      // ============================================================

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

      // ============================================================
      // 覚えて系
      // ============================================================

      const shouldRemember =
        userMessage.includes("覚え") ||
        userMessage.includes("記憶して") ||
        userMessage.includes("忘れないで") ||
        userMessage.includes("忘れんで");

      let newlySaved = [];

      if (shouldRemember) {
        newlySaved =
          extractMemories(userMessage);

        for (const item of newlySaved) {
          memories =
            upsertMemory(
              memories,
              item
            );
        }

        // 特定形式に当てはまらない「覚えて」も保存
        if (newlySaved.length === 0) {
          memories =
            upsertMemory(
              memories,
              {
                type: "general",

                key:
                  "general_" +
                  simpleHash(userMessage),

                value: userMessage,

                text: userMessage,

                savedAt:
                  new Date().toISOString(),
              }
            );
        }

        memories =
          memories.slice(-50);

        await env.MEMORY.put(
          memoryKey,
          JSON.stringify(memories)
        );

        const savedReply =
          buildSavedReply(newlySaved);

        if (savedReply) {
          const replyText =
            cleanReply(savedReply);

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
      }

      // ============================================================
      // 名前・呼び方はコード側で確実に回答
      // ============================================================

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

      // ============================================================
      // 好きな食べ物もコード側で確実に回答
      // ============================================================

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

      history =
        history.slice(-16);

      // ============================================================
      // Web検索判定
      // ============================================================

      const searchDecision =
        decideWhetherToSearch(
          userMessage
        );

      let searched = false;
      let searchAttempted =
        searchDecision.search;

      let webContext = "";
      let sourceUrls = [];

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
【資料 ${index + 1}】

タイトル:
${item.title}

内容:
${item.content}
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
            "SEARCH ERROR:",
            error
          );
        }
      }

      // ============================================================
      // 検索したのに結果0件ならAIに推測させない
      // ============================================================

      if (
        searchAttempted &&
        !searched
      ) {
        const noResultReply =
          "ごめん、今うまく検索結果を確認できんかった💦";

        await saveHistory(
          historyKey,
          history,
          userMessage,
          noResultReply,
          env
        );

        await replyToLine(
          event.replyToken,
          noResultReply,
          env
        );

        continue;
      }

      // ============================================================
      // 通常会話だけ記憶・履歴を使用
      //
      // Web検索時は個人情報・過去会話をAIへ渡さない
      // ============================================================

      let memoryContext = "なし";
      let historyForAI = [];

      if (!searched) {
        const relevant =
          selectRelevantMemories(
            userMessage,
            memories
          );

        memoryContext =
          relevant.length > 0
            ? relevant
                .map(
                  item =>
                    memoryToText(item)
                )
                .join("\n")
            : "なし";

        historyForAI =
          history.slice(-10);
      }

      // ============================================================
      // システムプロンプト
      // ============================================================

      const systemPrompt = `
あなたの名前は「ちゃぴ」。

LINEにいる、
明るく親しみやすい博多の女の子です。

友達とのLINEのように
自然に会話してください。

最重要:
内部の思考過程や推論を書かないでください。
考え方の説明も不要です。
ユーザーに見せる最終回答だけを出力してください。


【話し方】

・自分のことは「ちゃぴ」と呼ぶ
・「俺」「僕」は使わない
・自然な博多弁
・雑談は短め
・質問には結論から答える
・絵文字は少しだけ
・毎回無理に質問で終わらせない
・知らないことを知っているふりをしない


【使ってよい博多弁】

「〜ばい」
「〜たい」
「〜と？」
「〜けん」
「よかよ」
「〜しとる」
「〜しよった」
「〜っちゃけど」


【禁止する関西弁】

「やで」
「やん」
「せや」
「ほんま」
「なんでやねん」
「ええで」
「ええやろ」
「なんや」
「みたいや」
「やったんや」
「あるんや」
「できるんや」
「なるんや」


【記憶について】

下の「今回使ってよい長期記憶」に書いてある情報だけ、
ユーザーについて覚えている情報として使用できます。

「なし」の場合は、
過去に覚えた情報を推測してはいけません。

ユーザーが聞いていない記憶を
無関係な話題に突然混ぜないでください。


【Web検索済みの場合】

Web検索済みなら、
下の「検索資料」だけを事実情報の根拠として使ってください。

モデル自身の古い知識や推測を
追加してはいけません。

検索回答には、
ユーザーの名前、
呼び方、
好きな食べ物、
過去の会話などの
個人記憶を混ぜてはいけません。

検索資料に書かれていない内容を
事実として断定してはいけません。

特に、

・発売日
・価格
・スペック
・対応機能
・ゲーム名
・アップデート内容
・サービス内容
・日付
・数字

は資料に明記された情報だけを使ってください。


【情報が食い違う場合】

複数の検索資料で
数字や事実が食い違う場合は、

「情報が食い違っとる」

と明確に伝えてください。

公式サイトの情報がある場合は、
公式情報を優先してください。


【最新情報】

ユーザーが「最新情報」と聞いた場合は、

昔の発表を
最新ニュースのように説明してはいけません。

検索資料から確認できる
最近の更新、
現在の仕様、
最近の発表を中心に答えてください。

古い情報しか資料にない場合は、
そのことを正直に伝えてください。


【URL】

回答本文にはURLを書かないでください。

参考URLは
プログラム側で自動追加します。


【Markdown禁止】

以下は禁止です。

**
#
Markdownリンク


【今回使ってよい長期記憶】

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

      // ============================================================
      // AI
      //
      // Qwen3はreasoningを使うため
      // max_tokensを十分確保する
      // ============================================================

      let aiResponse =
        await runAI(
          messages,
          env,
          {
            maxTokens:
              searched
                ? 1400
                : 1000,

            temperature:
              searched
                ? 0.1
                : 0.45,
          }
        );

      let replyText =
        extractAIText(aiResponse);

      // ============================================================
      // reasoningだけで終わった場合は1回だけ再試行
      // ============================================================

      if (!replyText) {
        console.log(
          "EMPTY AI CONTENT - RETRY"
        );

        const retryMessages = [
          {
            role: "system",
            content:
              "日本語で最終回答だけを返してください。思考過程、分析、推論は出力しないでください。短く直接回答してください。",
          },

          {
            role: "user",
            content:
              searched
                ? `
次の検索資料だけを使って質問に答えてください。

質問:
${userMessage}

検索資料:
${webContext}

URLは書かないでください。
最終回答だけを書いてください。
`
                : `
次の質問に自然な日本語で短く答えてください。

質問:
${userMessage}

最終回答だけを書いてください。
`,
          },
        ];

        aiResponse =
          await runAI(
            retryMessages,
            env,
            {
              maxTokens: 1600,
              temperature:
                searched
                  ? 0.05
                  : 0.3,
            }
          );

        replyText =
          extractAIText(aiResponse);
      }

      if (!replyText) {
        replyText =
          "ごめん、今うまく返事できんかった💦";
      }

      replyText =
        cleanReply(replyText);

      // ============================================================
      // 参考URL
      // ============================================================

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

      // ============================================================
      // LINE最大文字数対策
      // ============================================================

      lineReply =
        lineReply.slice(
          0,
          4900
        );

      // ============================================================
      // 履歴保存
      // ============================================================

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
  messages,
  env,
  options = {}
) {
  const maxTokens =
    options.maxTokens || 1000;

  const temperature =
    options.temperature ?? 0.3;

  return await env.AI.run(
    "@cf/qwen/qwen3-30b-a3b-fp8",
    {
      messages,

      max_tokens:
        maxTokens,

      temperature,

      repetition_penalty:
        1.08,
    }
  );
}


// ============================================================
// 検索判定
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
      word =>
        text.includes(word)
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
    "今の",
    "今日の",
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
      word =>
        text.includes(word)
    );

  if (!shouldSearch) {
    return {
      search: false,
      query: "",
      freshness: "none",
    };
  }

  let freshness =
    "none";

  if (
    text.includes("今日") ||
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

    freshness,
  };
}


// ============================================================
// 検索語整形
// ============================================================

function cleanSearchQuery(text) {
  const cleaned =
    String(text || "")
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

  return (
    cleaned ||
    String(text || "")
      .trim()
      .slice(0, 300)
  );
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
    `tavily:v11:${simpleHash(
      `${query}:${freshness}`
    )}`;

  // ============================================================
  // キャッシュ
  // ============================================================

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
      "CACHE READ ERROR:",
      error
    );
  }

  const preferredDomains =
    detectPreferredDomains(query);

  let rawResults = [];

  // ============================================================
  // 優先サイト検索
  // ============================================================

  if (
    preferredDomains.length > 0
  ) {
    try {
      rawResults =
        await callTavily(
          query,
          freshness,
          env,
          preferredDomains
        );
    } catch (error) {
      console.error(
        "PREFERRED SEARCH ERROR:",
        error
      );
    }
  }

  // ============================================================
  // 一般検索追加
  // ============================================================

  if (
    rawResults.length < 4
  ) {
    try {
      const general =
        await callTavily(
          query,
          freshness,
          env,
          []
        );

      rawResults =
        mergeResults(
          rawResults,
          general
        );
    } catch (error) {
      console.error(
        "GENERAL SEARCH ERROR:",
        error
      );
    }
  }

  // ============================================================
  // 期間指定で少なければ期間なし検索
  // ============================================================

  if (
    rawResults.length < 3 &&
    freshness !== "none"
  ) {
    try {
      const retry =
        await callTavily(
          query,
          "none",
          env,
          preferredDomains
        );

      rawResults =
        mergeResults(
          rawResults,
          retry
        );
    } catch (error) {
      console.error(
        "SEARCH RETRY ERROR:",
        error
      );
    }
  }

  // ============================================================
  // 品質フィルター
  // ============================================================

  const results =
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
              1600
            ),

          score:
            typeof item.score === "number"
              ? item.score
              : 0,

          trust:
            trustScore(
              item.url || "",
              preferredDomains
            ),

          relevance:
            keywordOverlap(
              query,
              `${item.title || ""} ${item.content || ""}`
            ),
        })
      )
      .filter(
        item =>
          item.title &&
          item.url &&
          item.score >= 0.25 &&
          item.relevance > 0
      )
      .sort(
        (a, b) => {
          const aTotal =
            a.trust * 3 +
            a.relevance * 2 +
            a.score;

          const bTotal =
            b.trust * 3 +
            b.relevance * 2 +
            b.score;

          return (
            bTotal -
            aTotal
          );
        }
      )
      .slice(0, 5)
      .map(
        item => ({
          title:
            item.title,

          url:
            item.url,

          content:
            item.content,

          score:
            item.score,
        })
      );

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
        expirationTtl: 900,
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
  includeDomains
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
      false,

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
          JSON.stringify(
            requestBody
          ),
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

  return Array.isArray(
    data?.results
  )
    ? data.results
    : [];
}


// ============================================================
// 優先ドメイン
// ============================================================

function detectPreferredDomains(query) {
  const text =
    String(query || "")
      .toLowerCase();

  if (
    text.includes("nintendo") ||
    text.includes("switch") ||
    text.includes("任天堂")
  ) {
    return [
      "nintendo.com",
      "nintendo.co.jp",
      "famitsu.com",
      "gamewith.jp",
      "game8.jp",
    ];
  }

  if (
    text.includes("playstation") ||
    text.includes("ps5") ||
    text.includes("sony")
  ) {
    return [
      "playstation.com",
      "sony.com",
      "famitsu.com",
      "gamewith.jp",
      "game8.jp",
    ];
  }

  if (
    text.includes("iphone") ||
    text.includes("apple")
  ) {
    return [
      "apple.com",
      "support.apple.com",
    ];
  }

  if (
    text.includes("microsoft") ||
    text.includes("windows") ||
    text.includes("xbox")
  ) {
    return [
      "microsoft.com",
      "support.microsoft.com",
      "xbox.com",
    ];
  }

  return [];
}


// ============================================================
// 信頼度
// ============================================================

function trustScore(
  url,
  preferredDomains
) {
  const domain =
    getDomain(url);

  for (
    const preferred of preferredDomains
  ) {
    if (
      domain === preferred ||
      domain.endsWith(
        `.${preferred}`
      )
    ) {
      return 3;
    }
  }

  const generalTrusted = [
    "nintendo.com",
    "nintendo.co.jp",
    "apple.com",
    "microsoft.com",
    "sony.com",
    "playstation.com",
    "famitsu.com",
    "gamewith.jp",
    "game8.jp",
  ];

  if (
    generalTrusted.some(
      trusted =>
        domain === trusted ||
        domain.endsWith(
          `.${trusted}`
        )
    )
  ) {
    return 2;
  }

  return 0;
}


// ============================================================
// 検索安全判定
// ============================================================

function isSafeSearchResult(item) {
  const url =
    String(
      item?.url || ""
    ).toLowerCase();

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
// 関連度
// ============================================================

function keywordOverlap(
  query,
  target
) {
  const words =
    extractKeywords(query);

  if (
    words.length === 0
  ) {
    return 1;
  }

  const normalized =
    String(target || "")
      .toLowerCase();

  let matched = 0;

  for (const word of words) {
    if (
      normalized.includes(
        word.toLowerCase()
      )
    ) {
      matched++;
    }
  }

  return (
    matched /
    words.length
  );
}


function extractKeywords(text) {
  const cleaned =
    String(text || "")
      .replace(
        /[？?！!。、,.]/g,
        " "
      )
      .replace(
        /(最新情報|最新|最近|調べて|検索して|教えて|について|とは|ニュース|現在|今日)/g,
        " "
      );

  return cleaned
    .split(/\s+/)
    .map(
      word =>
        word.trim()
    )
    .filter(
      word =>
        word.length >= 2
    )
    .slice(0, 8);
}


// ============================================================
// 検索結果結合
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
    String(text || "").match(
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
    String(text || "").match(
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
    String(text || "").match(
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
// 古い記憶データ移行
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

    if (
      extracted.length > 0
    ) {
      for (
        const converted of extracted
      ) {
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
    } else {
      result.push({
        type: "general",

        key:
          item?.key ||
          "general_" +
          simpleHash(text),

        value: text,

        text,

        savedAt:
          item?.savedAt || "",
      });
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
    copy[index] =
      item;
  } else {
    copy.push(item);
  }

  return copy;
}


// ============================================================
// 記憶保存時の返答
// ============================================================

function buildSavedReply(items) {
  const name =
    items.find(
      item =>
        item.key === "name"
    )?.value;

  const nickname =
    items.find(
      item =>
        item.key === "nickname"
    )?.value;

  const food =
    items.find(
      item =>
        item.key === "favorite_food"
    )?.value;

  if (
    name &&
    nickname
  ) {
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
// 名前・呼び方
// ============================================================

function buildExactProfileReply(
  message,
  memories
) {
  const text =
    String(message || "");

  const asksName =
    text.includes("名前");

  const asksNickname =
    text.includes("呼び");

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
// 好きな食べ物
// ============================================================

function buildExactFoodReply(
  message,
  memories
) {
  const text =
    String(message || "");

  if (
    !text.includes(
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
// 関連記憶だけ選択
// ============================================================

function selectRelevantMemories(
  message,
  memories
) {
  const text =
    String(message || "");

  if (
    text.includes("名前") ||
    text.includes("呼び")
  ) {
    return memories.filter(
      item =>
        item.key === "name" ||
        item.key === "nickname"
    );
  }

  if (
    text.includes("食べ物") ||
    text.includes("カレー")
  ) {
    return memories.filter(
      item =>
        item.key === "favorite_food"
    );
  }

  return [];
}


// ============================================================
// 記憶→AI用テキスト
// ============================================================

function memoryToText(item) {
  if (
    item.key === "name"
  ) {
    return (
      `名前: ${item.value}`
    );
  }

  if (
    item.key === "nickname"
  ) {
    return (
      `呼び方: ${item.value}`
    );
  }

  if (
    item.key === "favorite_food"
  ) {
    return (
      `好きな食べ物: ${item.value}`
    );
  }

  return (
    item.text ||
    item.value ||
    ""
  );
}


// ============================================================
// 記憶文字列整形
// ============================================================

function cleanMemoryValue(value) {
  return String(value || "")
    .replace(
      /って.*$/g,
      ""
    )
    .replace(
      /覚えて.*$/g,
      ""
    )
    .replace(
      /でいい.*$/g,
      ""
    )
    .trim();
}


function cleanFoodValue(value) {
  return String(value || "")
    .replace(
      /って.*$/g,
      ""
    )
    .replace(
      /覚えて.*$/g,
      ""
    )
    .trim();
}


// ============================================================
// AI回答抽出
//
// Qwen3は content が null の場合がある。
// reasoning はユーザーへの回答として使わない。
// ============================================================

function extractAIText(aiResponse) {
  if (!aiResponse) {
    return "";
  }

  const choice =
    aiResponse
      ?.choices
      ?.[0]
      ?.message
      ?.content;

  if (
    typeof choice === "string" &&
    choice.trim()
  ) {
    return choice.trim();
  }

  if (
    typeof aiResponse?.response ===
      "string" &&
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


// ============================================================
// 回答整形
// ============================================================

function cleanReply(text) {
  return String(text || "")
    .replace(
      /\*\*/g,
      ""
    )
    .replace(
      /^#{1,6}\s*/gm,
      ""
    )
    .replace(
      /https?:\/\/[^\s]+/gi,
      ""
    )
    .replace(
      /ちゃび/g,
      "ちゃぴ"
    )
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
    .replace(
      /やで/g,
      "ばい"
    )
    .replace(
      /ほんま/g,
      "ほんと"
    )
    .replace(
      /\n{3,}/g,
      "\n\n"
    )
    .trim();
}


// ============================================================
// 履歴保存
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

  try {
    await env.MEMORY.put(
      historyKey,
      JSON.stringify(updated)
    );
  } catch (error) {
    console.error(
      "HISTORY WRITE ERROR:",
      error
    );
  }
}


// ============================================================
// ドメイン取得
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
  const input =
    String(text || "");

  let hash =
    2166136261;

  for (
    let i = 0;
    i < input.length;
    i++
  ) {
    hash ^=
      input.charCodeAt(i);

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
  if (!replyToken) {
    console.error(
      "LINE REPLY TOKEN MISSING"
    );

    return;
  }

  const finalText =
    String(text || "")
      .slice(
        0,
        5000
      );

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
                text: finalText,
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
// JSONレスポンス
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
