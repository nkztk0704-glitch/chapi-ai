export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ============================================================
    // 検索診断
    // 例:
    // ?check=search&q=ダダサバイバー 今来てるイベント
    // ============================================================

    if (
      request.method === "GET" &&
      url.searchParams.get("check") === "search"
    ) {
      try {
        const query =
          url.searchParams.get("q") ||
          "ダダサバイバー 今来てるイベント";

        const result =
          await searchWeb(
            query,
            env
          );

        return jsonResponse({
          success: true,
          ...result,
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
    // AI診断
    // ============================================================

    if (
      request.method === "GET" &&
      url.searchParams.get("check") === "ai"
    ) {
      try {
        const raw =
          await runAI(
            [
              {
                role: "system",
                content:
                  "日本語で最終回答だけを返してください。",
              },
              {
                role: "user",
                content:
                  "AIテスト成功とだけ答えてください。",
              },
            ],
            env,
            500,
            0.1
          );

        return jsonResponse({
          success: true,
          extracted:
            extractAIText(raw),
          rawResponse:
            raw,
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
    // 通常
    // ============================================================

    if (
      request.method !== "POST"
    ) {
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
      handleEvents(
        events,
        env
      )
    );

    return new Response("OK");
  },
};


// ============================================================
// LINEイベント
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
        event.message?.type !== "text"
      ) {
        continue;
      }

      const userMessage =
        String(
          event.message.text || ""
        ).trim();

      if (!userMessage) {
        continue;
      }

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
      // 履歴
      // ============================================================

      let history =
        await readArrayKV(
          env,
          historyKey
        );


      // ============================================================
      // 記憶
      // ============================================================

      let memories =
        await readArrayKV(
          env,
          memoryKey
        );

      const migrated =
        migrateAllMemories(
          memories
        );

      memories =
        migrated.memories;

      if (
        migrated.changed
      ) {
        await safeKVPut(
          env,
          memoryKey,
          memories
        );
      }


      // ============================================================
      // 全部忘れる
      // ============================================================

      if (
        userMessage.includes(
          "全部忘れて"
        ) ||
        userMessage.includes(
          "全部忘れろ"
        ) ||
        userMessage.includes(
          "記憶消して"
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
      // 記憶保存
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

      if (shouldRemember) {
        const extracted =
          extractMemories(
            userMessage
          );

        for (
          const item of extracted
        ) {
          memories =
            upsertMemory(
              memories,
              item
            );
        }

        if (
          extracted.length > 0
        ) {
          memories =
            memories.slice(-50);

          await safeKVPut(
            env,
            memoryKey,
            memories
          );

          const reply =
            buildSavedReply(
              extracted
            );

          await saveHistory(
            env,
            historyKey,
            history,
            userMessage,
            reply
          );

          await replyToLine(
            event.replyToken,
            reply,
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
          env,
          historyKey,
          history,
          userMessage,
          profileReply
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
          env,
          historyKey,
          history,
          userMessage,
          foodReply
        );

        await replyToLine(
          event.replyToken,
          foodReply,
          env
        );

        continue;
      }


      // ============================================================
      // 検索判定
      // ============================================================

      const searchDecision =
        decideSearch(
          userMessage
        );

      let searchData =
        null;

      if (
        searchDecision.search
      ) {
        try {
          searchData =
            await searchWeb(
              searchDecision.query,
              env
            );
        } catch (error) {
          console.error(
            "SEARCH ERROR:",
            error
          );
        }


        // 本当にTavilyから何も返らなかった時だけ失敗扱い
        if (
          !searchData ||
          !Array.isArray(
            searchData.results
          ) ||
          searchData.results.length === 0
        ) {
          const reply =
            "ごめん、検索APIから結果が返ってこんかった💦";

          await saveHistory(
            env,
            historyKey,
            history,
            userMessage,
            reply
          );

          await replyToLine(
            event.replyToken,
            reply,
            env
          );

          continue;
        }
      }


      // ============================================================
      // AIへ渡す内容
      // ============================================================

      let systemPrompt;
      let aiHistory = [];

      if (
        searchDecision.search
      ) {
        // 検索時は個人記憶・過去会話を一切渡さない

        const sourcesText =
          searchData.results
            .slice(0, 6)
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

        systemPrompt = `
あなたの名前は「ちゃぴ」。
LINEで話す、明るく親しみやすい博多の女の子です。

今回の質問はWeb検索済みです。

最重要ルール:
・下の検索資料だけを根拠に答える
・自分の古い知識を足さない
・過去の会話や個人記憶を混ぜない
・資料にない数字や日付を作らない
・分からない部分は「検索資料では確認できんかった」と言う
・最初に結論を答える
・長すぎない
・自然な博多弁
・自分のことは「ちゃぴ」
・関西弁は禁止
・URLは本文に書かない

現在の日付:
${getCurrentDateString()}

ユーザーが「今」「最新」「開催中」と聞いた場合は、
現在の日付に近い情報を優先してください。

ダダサバイバーは、
英語圏では Survivor.io と表記されることがあります。

ダダサバイバーについて、
イベント、交換、装備、S級軍備、サバイバー、
コレクション、欠片、無課金攻略などを聞かれた場合は、
検索資料を比較して実用的に答えてください。

【検索資料】
${sourcesText}
`;

      } else {
        const relevant =
          selectRelevantMemories(
            userMessage,
            memories
          );

        const memoryText =
          relevant.length
            ? relevant
                .map(
                  memoryToText
                )
                .join("\n")
            : "なし";

        systemPrompt = `
あなたの名前は「ちゃぴ」。
LINEにいる、明るく親しみやすい博多の女の子です。

・自然な博多弁
・自分のことは「ちゃぴ」
・「俺」「僕」は使わない
・関西弁は禁止
・雑談は短め
・友達とのLINEのように自然に話す
・毎回無理に質問で終わらせない
・知らないことを作らない

今回使ってよい長期記憶:
${memoryText}
`;

        aiHistory =
          history.slice(-10);
      }


      const messages = [
        {
          role: "system",
          content:
            systemPrompt,
        },

        ...aiHistory,

        {
          role: "user",
          content:
            userMessage,
        },
      ];


      // ============================================================
      // AI
      // ============================================================

      let rawAI;

      try {
        rawAI =
          await runAI(
            messages,
            env,
            searchDecision.search
              ? 1800
              : 1000,
            searchDecision.search
              ? 0.15
              : 0.45
          );
      } catch (error) {
        console.error(
          "AI RUN ERROR:",
          error
        );

        await replyToLine(
          event.replyToken,
          "ごめん、AI側でエラーが出た💦",
          env
        );

        continue;
      }


      let replyText =
        extractAIText(
          rawAI
        );


      // Qwenがreasoningだけで終わった時だけ再試行
      if (!replyText) {
        try {
          const retry =
            await runAI(
              [
                {
                  role:
                    "system",

                  content:
                    "思考過程は出さず、日本語の最終回答だけ返してください。",
                },

                {
                  role:
                    "user",

                  content:
                    searchDecision.search
                      ? `
質問:
${userMessage}

以下の資料だけで答えてください:

${searchData.results
  .slice(0, 5)
  .map(
    item =>
      `${item.title}\n${item.content}`
  )
  .join("\n\n")}
`
                      : userMessage,
                },
              ],
              env,
              2000,
              0.1
            );

          replyText =
            extractAIText(
              retry
            );

        } catch (error) {
          console.error(
            "AI RETRY ERROR:",
            error
          );
        }
      }


      if (!replyText) {
        replyText =
          "ごめん、今うまく返事できんかった💦";
      }


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
        searchDecision.search &&
        searchData?.results?.length
      ) {
        const urls =
          [
            ...new Set(
              searchData.results
                .slice(0, 3)
                .map(
                  item =>
                    item.url
                )
                .filter(Boolean)
            ),
          ];

        if (urls.length) {
          lineReply +=
            "\n\n🔎 参考\n" +
            urls
              .map(
                (
                  item,
                  index
                ) =>
                  `${index + 1}. ${item}`
              )
              .join("\n");
        }
      }


      // ============================================================
      // 履歴
      // ============================================================

      await saveHistory(
        env,
        historyKey,
        history,
        userMessage,
        replyText
      );


      // ============================================================
      // LINE
      // ============================================================

      await replyToLine(
        event.replyToken,
        lineReply,
        env
      );

    } catch (error) {
      console.error(
        "EVENT ERROR:",
        error
      );
    }
  }
}


// ============================================================
// 検索判定
// ============================================================

function decideSearch(
  message
) {
  const text =
    String(
      message || ""
    ).trim();

  // 記憶確認は検索しない
  const memoryTerms = [
    "俺の名前",
    "私の名前",
    "僕の名前",
    "呼び方",
    "好きな食べ物",
    "覚えとる",
    "覚えてる",
  ];

  if (
    memoryTerms.some(
      term =>
        text.includes(term)
    )
  ) {
    return {
      search: false,
      query: "",
    };
  }


  // ダダサバ関連は基本的に検索
  const survivorTerms = [
    "ダダサバ",
    "ダダサバイバー",
    "Survivor.io",
    "S級軍備",
    "S級装備",
    "メモリーエディター",
    "キティース",
    "タローシア",
    "コレクション",
    "欠片",
    "テックパーツ",
  ];

  if (
    survivorTerms.some(
      term =>
        text
          .toLowerCase()
          .includes(
            term.toLowerCase()
          )
    )
  ) {
    return {
      search: true,
      query:
        buildSearchQuery(
          text,
          true
        ),
    };
  }


  // 一般検索
  const webTerms = [
    "調べて",
    "検索して",
    "最新",
    "現在",
    "今の",
    "今日",
    "ニュース",
    "価格",
    "値段",
    "発売",
    "イベント",
    "アップデート",
    "在庫",
    "営業時間",
    "天気",
    "結果",
  ];

  const needsSearch =
    webTerms.some(
      term =>
        text.includes(term)
    );

  return {
    search:
      needsSearch,

    query:
      needsSearch
        ? buildSearchQuery(
            text,
            false
          )
        : "",
  };
}


// ============================================================
// 検索語作成
// ============================================================

function buildSearchQuery(
  message,
  isSurvivor
) {
  let text =
    String(
      message || ""
    )
      .replace(
        /調べて教えて/g,
        ""
      )
      .replace(
        /調べて/g,
        ""
      )
      .replace(
        /検索して教えて/g,
        ""
      )
      .replace(
        /検索して/g,
        ""
      )
      .replace(
        /教えて/g,
        ""
      )
      .trim();


  if (isSurvivor) {
    const date =
      new Date();

    const year =
      date.getUTCFullYear();

    const month =
      date.getUTCMonth() + 1;

    text =
      `${text} Survivor.io ${year}年${month}月`;
  }

  return text.slice(
    0,
    300
  );
}


// ============================================================
// Web検索
// ============================================================

async function searchWeb(
  query,
  env
) {
  if (
    !env.TAVILY_API_KEY
  ) {
    throw new Error(
      "TAVILY_API_KEY がありません"
    );
  }


  const survivor =
    isSurvivorQuery(
      query
    );


  const cacheKey =
    `search:v40:${simpleHash(
      query
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
        JSON.parse(
          cached
        );

      if (
        Array.isArray(
          parsed?.results
        ) &&
        parsed.results.length
      ) {
        return parsed;
      }
    }
  } catch (error) {
    console.error(
      "CACHE ERROR:",
      error
    );
  }


  // ============================================================
  // 検索語候補
  // ============================================================

  const queries = [
    query,
  ];


  if (survivor) {
    const now =
      new Date();

    const year =
      now.getUTCFullYear();

    const month =
      now.getUTCMonth() + 1;

    const englishMonth =
      [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
      ][month - 1];


    queries.push(
      `ダダサバイバー ${year}年${month}月 イベント`
    );

    queries.push(
      `Survivor.io ${englishMonth} ${year} event`
    );
  }


  // ============================================================
  // Tavilyを並列検索
  //
  // 日本語ゲーム検索ではtime_rangeを強制しない
  // ============================================================

  const settled =
    await Promise.allSettled(
      queries.map(
        q =>
          callTavily(
            q,
            env
          )
      )
    );


  let rawResults =
    [];


  for (
    const response of settled
  ) {
    if (
      response.status !==
      "fulfilled"
    ) {
      console.error(
        "TAVILY QUERY ERROR:",
        response.reason
      );

      continue;
    }

    const data =
      response.value;

    if (
      Array.isArray(
        data?.results
      )
    ) {
      rawResults =
        mergeResults(
          rawResults,
          data.results
        );
    }
  }


  // ============================================================
  // ここが今回の重要修正
  //
  // Tavilyが返した結果を
  // score/relevanceで勝手に全消ししない
  // ============================================================

  let results =
    rawResults
      .filter(
        item =>
          item &&
          item.title &&
          item.url
      )
      .filter(
        isSafeSearchResult
      );


  // ダダサバ関連結果が取れていたら上に持ってくるだけ。
  // 関連しない結果を全部削除はしない。
  if (survivor) {
    results.sort(
      (a, b) =>
        survivorResultScore(
          b
        ) -
        survivorResultScore(
          a
        )
    );
  }


  results =
    results
      .slice(0, 8)
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
              2200
            ),

          score:
            typeof item.score ===
              "number"
              ? item.score
              : 0,

          publishedDate:
            String(
              item.published_date ||
              item.publishedDate ||
              ""
            ),
        })
      );


  const result = {
    query,
    results,
    searchedAt:
      new Date()
        .toISOString(),
  };


  // ============================================================
  // キャッシュ
  // ============================================================

  if (
    results.length
  ) {
    await env.MEMORY.put(
      cacheKey,
      JSON.stringify(
        result
      ),
      {
        expirationTtl:
          300,
      }
    );
  }


  return result;
}


// ============================================================
// Tavily API
// ============================================================

async function callTavily(
  query,
  env
) {
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
          JSON.stringify({
            query,

            search_depth:
              "advanced",

            chunks_per_source:
              3,

            max_results:
              10,

            topic:
              "general",

            include_answer:
              false,

            include_raw_content:
              false,

            include_images:
              false,

            auto_parameters:
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
          }),
      }
    );


  const body =
    await response.text();


  if (
    !response.ok
  ) {
    throw new Error(
      `Tavily ${response.status}: ${body.slice(
        0,
        500
      )}`
    );
  }


  return JSON.parse(
    body
  );
}


// ============================================================
// ダダサバ検索判定
// ============================================================

function isSurvivorQuery(
  text
) {
  const value =
    String(
      text || ""
    ).toLowerCase();

  return (
    value.includes(
      "ダダサバ"
    ) ||
    value.includes(
      "survivor.io"
    ) ||
    value.includes(
      "survivor io"
    )
  );
}


// ============================================================
// ダダサバ結果優先度
// ============================================================

function survivorResultScore(
  item
) {
  const text =
    `${item?.title || ""} ${item?.content || ""}`
      .toLowerCase();

  let score = 0;

  if (
    text.includes(
      "survivor.io"
    )
  ) {
    score += 5;
  }

  if (
    text.includes(
      "ダダサバ"
    )
  ) {
    score += 5;
  }

  if (
    text.includes(
      "event"
    ) ||
    text.includes(
      "イベント"
    )
  ) {
    score += 3;
  }


  const now =
    new Date();

  const year =
    String(
      now.getUTCFullYear()
    );

  if (
    text.includes(
      year
    )
  ) {
    score += 2;
  }


  return score;
}


// ============================================================
// 安全フィルター
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
// 検索結果統合
// ============================================================

function mergeResults(
  first,
  second
) {
  const map =
    new Map();


  for (
    const item of [
      ...(first || []),
      ...(second || []),
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
// AI
// ============================================================

async function runAI(
  messages,
  env,
  maxTokens,
  temperature
) {
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
// AI返答抽出
// ============================================================

function extractAIText(
  response
) {
  if (!response) {
    return "";
  }


  const content =
    response
      ?.choices
      ?.[0]
      ?.message
      ?.content;


  if (
    typeof content ===
      "string" &&
    content.trim()
  ) {
    return content.trim();
  }


  if (
    typeof response
      ?.response ===
      "string" &&
    response
      .response
      .trim()
  ) {
    return response
      .response
      .trim();
  }


  if (
    typeof response
      ?.result
      ?.response ===
      "string" &&
    response
      .result
      .response
      .trim()
  ) {
    return response
      .result
      .response
      .trim();
  }


  return "";
}


// ============================================================
// 記憶
// ============================================================

function extractMemories(
  text
) {
  const result =
    [];

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


// ============================================================
// 古い記憶移行
// ============================================================

function migrateAllMemories(
  raw
) {
  let result =
    [];

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


    // 旧好きな食べ物
    const foodMatch =
      text.match(
        /好きな食べ物(?:は|が)?[「『]?([^、。！!？?\n]+?)[」』]?(?:って|と)?(?:覚え|記憶|$)/
      );


    if (
      foodMatch?.[1]
    ) {
      result =
        upsertMemory(
          result,
          {
            type:
              "preference",

            key:
              "favorite_food",

            value:
              cleanFoodValue(
                foodMatch[1]
              ),

            savedAt:
              item?.savedAt ||
              new Date()
                .toISOString(),
          }
        );

      changed =
        true;

      continue;
    }


    const extracted =
      extractMemories(
        text
      );


    if (
      extracted.length
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

      changed =
        true;
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
    [
      ...memories,
    ];


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


// ============================================================
// 記憶保存返答
// ============================================================

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


  return (
    "覚えたよ👌"
  );
}


// ============================================================
// 名前・呼び方
// ============================================================

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
    `好きな食べ物は「${food}」ばい😊 ちゃんと覚えとるよ！`
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
          memory.key ===
          key
      )
      .sort(
        (
          a,
          b
        ) =>
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


// ============================================================
// 関係ある記憶だけ
// ============================================================

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


// ============================================================
// 記憶テキスト
// ============================================================

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


  return "";
}


// ============================================================
// 文字整形
// ============================================================

function cleanMemoryValue(
  value
) {
  return String(
    value ||
    ""
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
    value ||
    ""
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
      /記憶して.*$/g,
      ""
    )
    .replace(
      /[。！!？?]+$/g,
      ""
    )
    .trim();
}


// ============================================================
// AI返答クリーニング
// ============================================================

function cleanReply(
  text
) {
  return String(
    text ||
    ""
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
    .replace(
      /\n{3,}/g,
      "\n\n"
    )
    .trim();
}


// ============================================================
// KV
// ============================================================

async function readArrayKV(
  env,
  key
) {
  try {
    const saved =
      await env.MEMORY.get(
        key
      );


    if (!saved) {
      return [];
    }


    const parsed =
      JSON.parse(
        saved
      );


    return Array.isArray(
      parsed
    )
      ? parsed
      : [];

  } catch (error) {
    console.error(
      "KV READ ERROR:",
      error
    );

    return [];
  }
}


async function safeKVPut(
  env,
  key,
  value
) {
  try {
    await env.MEMORY.put(
      key,
      JSON.stringify(
        value
      )
    );
  } catch (error) {
    console.error(
      "KV WRITE ERROR:",
      error
    );
  }
}


// ============================================================
// 履歴
// ============================================================

async function saveHistory(
  env,
  key,
  history,
  userMessage,
  replyText
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


  await safeKVPut(
    env,
    key,
    updated
  );
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
                  String(
                    text ||
                    ""
                  ).slice(
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
      "LINE ERROR:",
      response.status,
      await response.text()
    );
  }
}


// ============================================================
// その他
// ============================================================

function simpleHash(
  text
) {
  const value =
    String(
      text ||
      ""
    );


  let hash =
    2166136261;


  for (
    let i = 0;
    i <
    value.length;
    i++
  ) {
    hash ^=
      value.charCodeAt(
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


function getCurrentDateString() {
  return new Date()
    .toISOString()
    .slice(
      0,
      10
    );
}


function jsonResponse(
  data
) {
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
