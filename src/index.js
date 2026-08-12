export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ============================================================
    // Qwen単体診断
    // ============================================================

    if (
      request.method === "GET" &&
      url.searchParams.get("check") === "ai"
    ) {
      try {
        const testMessages = [
          {
            role: "system",
            content:
              "あなたは日本語で短く答えるアシスタントです。",
          },
          {
            role: "user",
            content:
              "「AIテスト成功」とだけ返してください。",
          },
        ];

        const rawResponse =
          await env.AI.run(
            "@cf/qwen/qwen3-30b-a3b-fp8",
            {
              messages: testMessages,
              max_tokens: 80,
              temperature: 0.1,
              repetition_penalty: 1.1,
            }
          );

        const extracted =
          extractAIText(rawResponse);

        return jsonResponse({
          success: true,
          model:
            "@cf/qwen/qwen3-30b-a3b-fp8",
          extracted,
          rawResponse,
        });
      } catch (error) {
        return jsonResponse({
          success: false,
          error:
            String(
              error?.stack ||
              error?.message ||
              error
            ),
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
      return new Response(
        "ちゃぴAI is running!"
      );
    }

    let body;

    try {
      body =
        await request.json();
    } catch {
      return new Response("OK");
    }

    const events =
      body.events || [];

    ctx.waitUntil(
      handleEvents(events, env)
    );

    return new Response("OK");
  },
};


// ============================================================
// LINEイベント処理
// ============================================================

async function handleEvents(
  events,
  env
) {
  for (const event of events) {
    try {
      if (
        event.type !== "message"
      ) {
        continue;
      }

      if (
        event.message?.type !==
        "text"
      ) {
        continue;
      }

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


      // ============================================================
      // 会話履歴
      // ============================================================

      let history = [];

      try {
        const saved =
          await env.MEMORY.get(
            historyKey
          );

        if (saved) {
          const parsed =
            JSON.parse(saved);

          if (
            Array.isArray(parsed)
          ) {
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
          await env.MEMORY.get(
            memoryKey
          );

        if (saved) {
          const parsed =
            JSON.parse(saved);

          if (
            Array.isArray(parsed)
          ) {
            const migrated =
              migrateAllMemories(
                parsed
              );

            memories =
              migrated.memories;

            if (
              migrated.changed
            ) {
              await env.MEMORY.put(
                memoryKey,
                JSON.stringify(
                  memories
                )
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
        userMessage.includes(
          "全部忘れて"
        ) ||
        userMessage.includes(
          "記憶消して"
        ) ||
        userMessage.includes(
          "全部忘れろ"
        )
      ) {
        await env.MEMORY.delete(
          historyKey
        );

        await env.MEMORY.delete(
          memoryKey
        );

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
        userMessage.includes(
          "覚え"
        ) ||
        userMessage.includes(
          "記憶して"
        ) ||
        userMessage.includes(
          "忘れないで"
        ) ||
        userMessage.includes(
          "忘れんで"
        );

      let newlySaved = [];

      if (shouldRemember) {
        newlySaved =
          extractMemories(
            userMessage
          );

        for (
          const item of newlySaved
        ) {
          memories =
            upsertMemory(
              memories,
              item
            );
        }

        if (
          newlySaved.length === 0
        ) {
          memories =
            upsertMemory(
              memories,
              {
                type:
                  "general",

                key:
                  "general_" +
                  simpleHash(
                    userMessage
                  ),

                value:
                  userMessage,

                text:
                  userMessage,

                savedAt:
                  new Date()
                    .toISOString(),
              }
            );
        }

        memories =
          memories.slice(-50);

        await env.MEMORY.put(
          memoryKey,
          JSON.stringify(
            memories
          )
        );

        const savedReply =
          buildSavedReply(
            newlySaved
          );

        if (savedReply) {
          const replyText =
            cleanReply(
              savedReply
            );

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
      // 名前・呼び方
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
      // 好きな食べ物
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

      let searched =
        false;

      let webContext =
        "";

      let sourceUrls =
        [];


      if (
        searchDecision.search
      ) {
        try {
          const searchResult =
            await searchTavily(
              searchDecision.query,
              searchDecision.freshness,
              env
            );

          if (
            searchResult.results
              .length > 0
          ) {
            searched = true;

            webContext =
              searchResult.results
                .map(
                  (
                    item,
                    index
                  ) => `
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
                  item =>
                    item.url
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
      // Web検索時は記憶・過去履歴を渡さない
      // ============================================================

      let memoryContext =
        "なし";

      let historyForAI =
        [];

      if (
        !searchDecision.search
      ) {
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
                    memoryToText(
                      item
                    )
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


【話し方】

・自分のことは「ちゃぴ」と呼ぶ
・「俺」「僕」は使わない
・自然な博多弁
・雑談は短め
・質問は結論から
・絵文字は少しだけ


【使ってよい博多弁】

「〜ばい」
「〜たい」
「〜と？」
「〜けん」
「よかよ」
「〜しとる」
「〜しよった」


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


【重要：Web検索済みの場合】

今回Web検索済みなら、
下にある「検索資料」だけを使って回答してください。

あなた自身の古い知識を追加してはいけません。

過去の会話内容や
ユーザーの名前・好み・記憶を
検索回答に混ぜてはいけません。

ユーザーが聞いていない個人情報を
絶対に話題に出さないでください。

検索資料に明記されていない内容は
事実として答えてはいけません。

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

は資料に書いてあるものだけ使ってください。

検索資料同士で
内容が食い違う場合は、
断定しないでください。

検索結果がない場合は、

「今うまく検索結果を確認できんかった」

と伝えてください。


【最新情報という質問】

「最新情報」を聞かれた時は、

昔の発表を
最新ニュースのように
説明しないでください。

資料から
最近の更新・現在の仕様・最近の発表
として確認できる内容だけ答えてください。


【URL】

回答本文にURLを書かないでください。

URLと参考欄は
プログラム側で追加します。


【Markdown禁止】

「**」
「#」
Markdownリンク

は禁止です。


【今回使ってよい長期記憶】

${memoryContext}


【Web検索状態】

${searched
  ? "Web検索済み"
  : "Web検索なし"
}


【検索資料】

${webContext || "なし"}
`;


      const messages = [
        {
          role:
            "system",

          content:
            systemPrompt,
        },

        ...historyForAI,

        {
          role:
            "user",

          content:
            userMessage,
        },
      ];


      // ============================================================
      // AI
      // ============================================================

      let aiResponse;

      try {
        aiResponse =
          await env.AI.run(
            "@cf/qwen/qwen3-30b-a3b-fp8",
            {
              messages,

              max_tokens:
                450,

              temperature:
                searched
                  ? 0.1
                  : 0.4,

              repetition_penalty:
                1.1,
            }
          );

        console.log(
          "QWEN RAW RESPONSE:",
          JSON.stringify(
            aiResponse
          )
        );

      } catch (error) {
        console.error(
          "QWEN RUN ERROR:",
          error
        );

        aiResponse = null;
      }


      const extractedText =
        extractAIText(
          aiResponse
        );

      console.log(
        "QWEN EXTRACTED TEXT:",
        extractedText
      );


      let replyText =
        extractedText ||
        "ごめん、今うまく返事できんかった💦";


      replyText =
        cleanReply(
          replyText
        );


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
          [
            ...new Set(
              sourceUrls
            ),
          ];

        lineReply +=
          "\n\n🔎 参考\n" +
          uniqueUrls
            .map(
              (
                url,
                i
              ) =>
                `${i + 1}. ${url}`
            )
            .join("\n");
      }


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
// 検索判定
// ============================================================

function decideWhetherToSearch(
  message
) {
  const text =
    message.trim();

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
        text.includes(
          word
        )
    )
  ) {
    return {
      search: false,
      query: "",
      freshness:
        "none",
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
        text.includes(
          word
        )
    );

  if (!shouldSearch) {
    return {
      search: false,
      query: "",
      freshness:
        "none",
    };
  }

  let freshness =
    "none";

  if (
    text.includes(
      "今日"
    ) ||
    text.includes(
      "現在"
    )
  ) {
    freshness =
      "day";

  } else if (
    text.includes(
      "最新"
    ) ||
    text.includes(
      "最近"
    ) ||
    text.includes(
      "ニュース"
    )
  ) {
    freshness =
      "week";
  }

  return {
    search: true,

    query:
      cleanSearchQuery(
        text
      ),

    freshness,
  };
}


// ============================================================
// 検索語
// ============================================================

function cleanSearchQuery(
  text
) {
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
    .slice(
      0,
      300
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
  if (
    !env.TAVILY_API_KEY
  ) {
    throw new Error(
      "TAVILY_API_KEY が設定されていません"
    );
  }

  const cacheKey =
    `tavily:v11:${simpleHash(
      `${query}:${freshness}`
    )}`;

  try {
    const cached =
      await env.MEMORY.get(
        cacheKey
      );

    if (cached) {
      const parsed =
        JSON.parse(
          cached
        );

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
    detectPreferredDomains(
      query
    );

  let rawResults =
    [];


  if (
    preferredDomains.length >
    0
  ) {
    rawResults =
      await callTavily(
        query,
        freshness,
        env,
        preferredDomains
      );
  }


  if (
    rawResults.length <
    3
  ) {
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
  }


  if (
    rawResults.length <
      3 &&
    freshness !==
      "none"
  ) {
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
  }


  const results =
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
              item.title ||
              ""
            ),

          url:
            String(
              item.url ||
              ""
            ),

          content:
            String(
              item.content ||
              ""
            ).slice(
              0,
              1800
            ),

          score:
            typeof item.score ===
            "number"
              ? item.score
              : 0,

          trust:
            trustScore(
              item.url ||
                "",
              preferredDomains
            ),

          relevance:
            keywordOverlap(
              query,
              `${
                item.title ||
                ""
              } ${
                item.content ||
                ""
              }`
            ),
        })
      )
      .filter(
        item =>
          item.title &&
          item.url &&
          item.score >=
            0.30 &&
          item.relevance >
            0
      )
      .sort(
        (a, b) => {
          const aTotal =
            a.trust *
              3 +
            a.relevance *
              2 +
            a.score;

          const bTotal =
            b.trust *
              3 +
            b.relevance *
              2 +
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
      new Date()
        .toISOString(),
  };


  try {
    await env.MEMORY.put(
      cacheKey,
      JSON.stringify(
        result
      ),
      {
        expirationTtl:
          900,
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
    Array.isArray(
      includeDomains
    ) &&
    includeDomains.length >
      0
  ) {
    requestBody.include_domains =
      includeDomains;
  }


  if (
    freshness ===
      "day" ||
    freshness ===
      "week" ||
    freshness ===
      "month"
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


  if (
    !response.ok
  ) {
    throw new Error(
      `Tavily ${response.status}: ${text.slice(
        0,
        500
      )}`
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
// 質問ごとの信頼サイト
// ============================================================

function detectPreferredDomains(
  query
) {
  const text =
    String(query)
      .toLowerCase();


  if (
    text.includes(
      "nintendo"
    ) ||
    text.includes(
      "switch"
    ) ||
    text.includes(
      "任天堂"
    )
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
    text.includes(
      "playstation"
    ) ||
    text.includes(
      "ps5"
    ) ||
    text.includes(
      "sony"
    )
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
    text.includes(
      "iphone"
    ) ||
    text.includes(
      "apple"
    )
  ) {
    return [
      "apple.com",
      "support.apple.com",
    ];
  }


  if (
    text.includes(
      "microsoft"
    ) ||
    text.includes(
      "windows"
    ) ||
    text.includes(
      "xbox"
    )
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
    const preferred of
      preferredDomains
  ) {
    if (
      domain ===
        preferred ||
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
        domain ===
          trusted ||
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
// 安全判定
// ============================================================

function isSafeSearchResult(
  item
) {
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
      url.includes(
        domain
      )
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
    extractKeywords(
      query
    );


  if (
    words.length === 0
  ) {
    return 1;
  }


  const normalized =
    String(target)
      .toLowerCase();


  let matched = 0;


  for (
    const word of words
  ) {
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


function extractKeywords(
  text
) {
  const cleaned =
    String(text)
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
        word.length >=
        2
    )
    .slice(
      0,
      8
    );
}


// ============================================================
// 検索結果結合
// ============================================================

function mergeResults(
  a,
  b
) {
  const map =
    new Map();


  for (
    const item of [
      ...a,
      ...b,
    ]
  ) {
    if (
      !item?.url
    ) {
      continue;
    }


    if (
      !map.has(
        item.url
      )
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
// 記憶処理
// ============================================================

function extractMemories(
  text
) {
  const result = [];

  const now =
    new Date()
      .toISOString();


  const name =
    text.match(
      /(?:俺|私|僕)の名前は([^、。！!？?\s]+?)(?:って|と)?覚え/
    );


  if (
    name?.[1]
  ) {
    result.push({
      type:
        "profile",

      key:
        "name",

      value:
        cleanMemoryValue(
          name[1]
        ),

      savedAt:
        now,
    });
  }


  const nickname =
    text.match(
      /呼び方は([^、。！!？?\s]+?)(?:でいい|でよい|にして|って)/
    );


  if (
    nickname?.[1]
  ) {
    result.push({
      type:
        "profile",

      key:
        "nickname",

      value:
        cleanMemoryValue(
          nickname[1]
        ),

      savedAt:
        now,
    });
  }


  const food =
    text.match(
      /好きな食べ物(?:は|が)([^、。！!？?\n]+?)(?:って|と)?覚え/
    );


  if (
    food?.[1]
  ) {
    result.push({
      type:
        "preference",

      key:
        "favorite_food",

      value:
        cleanFoodValue(
          food[1]
        ),

      savedAt:
        now,
    });
  }


  return result;
}


function migrateAllMemories(
  raw
) {
  let result = [];

  let changed =
    false;


  for (
    const item of raw
  ) {
    if (
      item?.key ===
        "name" ||
      item?.key ===
        "nickname" ||
      item?.key ===
        "favorite_food"
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
      extractMemories(
        text
      );


    if (
      extracted.length >
      0
    ) {
      for (
        const converted of
          extracted
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
        type:
          "general",

        key:
          item?.key ||
          "general_" +
          simpleHash(
            text
          ),

        value:
          text,

        text,

        savedAt:
          item?.savedAt ||
          "",
      });
    }
  }


  return {
    memories:
      result.slice(-50),

    changed,
  };
}


function upsertMemory(
  memories,
  item
) {
  const copy =
    [...memories];


  const index =
    copy.findIndex(
      current =>
        current.key ===
        item.key
    );


  if (
    index >= 0
  ) {
    copy[index] =
      item;

  } else {
    copy.push(
      item
    );
  }


  return copy;
}


function buildSavedReply(
  items
) {
  const name =
    items.find(
      item =>
        item.key ===
        "name"
    )?.value;


  const nickname =
    items.find(
      item =>
        item.key ===
        "nickname"
    )?.value;


  const food =
    items.find(
      item =>
        item.key ===
        "favorite_food"
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


function buildExactProfileReply(
  message,
  memories
) {
  const asksName =
    message.includes(
      "名前"
    );


  const asksNickname =
    message.includes(
      "呼び"
    );


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
    asksNickname
  ) {
    if (
      name &&
      nickname
    ) {
      return (
        `名前は「${name}」で、` +
        `ちゃぴは「${nickname}」って呼ぶよ😊`
      );
    }
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


function getMemory(
  memories,
  key
) {
  const item =
    memories
      .filter(
        memory =>
          memory.key ===
          key
      )
      .sort(
        (a, b) =>
          String(
            b.savedAt ||
            ""
          ).localeCompare(
            String(
              a.savedAt ||
              ""
            )
          )
      )[0];


  return (
    item?.value ||
    ""
  );
}


function selectRelevantMemories(
  message,
  memories
) {
  if (
    message.includes(
      "名前"
    ) ||
    message.includes(
      "呼び"
    )
  ) {
    return memories.filter(
      item =>
        item.key ===
          "name" ||
        item.key ===
          "nickname"
    );
  }


  if (
    message.includes(
      "食べ物"
    ) ||
    message.includes(
      "カレー"
    )
  ) {
    return memories.filter(
      item =>
        item.key ===
        "favorite_food"
    );
  }


  return [];
}


function memoryToText(
  item
) {
  if (
    item.key ===
    "name"
  ) {
    return (
      `名前: ${item.value}`
    );
  }


  if (
    item.key ===
    "nickname"
  ) {
    return (
      `呼び方: ${item.value}`
    );
  }


  if (
    item.key ===
    "favorite_food"
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


function cleanMemoryValue(
  value
) {
  return String(
    value || ""
  )
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


function cleanFoodValue(
  value
) {
  return String(
    value || ""
  )
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
// 回答整形
// ============================================================

function cleanReply(
  text
) {
  return String(
    text || ""
  )
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
    .trim();
}


// ============================================================
// 共通
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
      role:
        "user",

      content:
        userMessage,
    },

    {
      role:
        "assistant",

      content:
        replyText,
    },

  ].slice(-16);


  await env.MEMORY.put(
    historyKey,
    JSON.stringify(
      updated
    )
  );
}


// ============================================================
// AI返答取り出し
// ============================================================

function extractAIText(
  aiResponse
) {
  if (
    !aiResponse
  ) {
    return "";
  }


  // Cloudflare / OpenAI互換
  const choice =
    aiResponse
      ?.choices
      ?.[0]
      ?.message
      ?.content;


  if (
    typeof choice ===
      "string" &&
    choice.trim()
  ) {
    return choice.trim();
  }


  // 一部Workers AI形式
  if (
    typeof aiResponse
      ?.response ===
      "string" &&
    aiResponse
      .response
      .trim()
  ) {
    return (
      aiResponse
        .response
        .trim()
    );
  }


  // result.response形式
  if (
    typeof aiResponse
      ?.result
      ?.response ===
      "string" &&
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


  // 万一 message.content が配列
  const arrayContent =
    aiResponse
      ?.choices
      ?.[0]
      ?.message
      ?.content;


  if (
    Array.isArray(
      arrayContent
    )
  ) {
    const combined =
      arrayContent
        .map(
          item => {
            if (
              typeof item ===
              "string"
            ) {
              return item;
            }

            if (
              typeof item?.text ===
              "string"
            ) {
              return item.text;
            }

            if (
              typeof item?.content ===
              "string"
            ) {
              return item.content;
            }

            return "";
          }
        )
        .join("")
        .trim();


    if (combined) {
      return combined;
    }
  }


  return "";
}


function getDomain(url) {
  try {
    return new URL(
      url
    )
      .hostname
      .toLowerCase();

  } catch {
    return "";
  }
}


function simpleHash(text) {
  let hash =
    2166136261;


  for (
    let i = 0;
    i < text.length;
    i++
  ) {
    hash ^=
      text.charCodeAt(
        i
      );


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
            `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
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
                  ),
              },
            ],
          }),
      }
    );


  if (
    !response.ok
  ) {
    console.error(
      "LINE REPLY ERROR:",
      response.status,
      await response.text()
    );
  }
}


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
