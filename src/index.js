export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ============================================================
    // AIテスト
    // ============================================================

    if (
      request.method === "GET" &&
      url.searchParams.get("check") === "ai"
    ) {
      try {
        const raw = await runAI(
          [
            {
              role: "system",
              content:
                "日本語の最終回答だけ返してください。思考過程は出力しないでください。",
            },
            {
              role: "user",
              content:
                "「AIテスト成功」とだけ答えてください。",
            },
          ],
          env,
          600,
          0.1
        );

        return jsonResponse({
          success: true,
          extracted: extractAIText(raw),
          rawResponse: raw,
        });
      } catch (error) {
        return jsonResponse({
          success: false,
          error: String(
            error?.stack ||
            error?.message ||
            error
          ),
        });
      }
    }

    // ============================================================
    // 検索テスト
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
          error: String(
            error?.stack ||
            error?.message ||
            error
          ),
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
// LINEイベント
// ============================================================

async function handleEvents(events, env) {
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

      let history =
        await readArrayKV(
          env,
          historyKey
        );

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

      if (migrated.changed) {
        await safeKVPut(
          env,
          memoryKey,
          memories
        );
      }

      // ============================================================
      // 全記憶削除
      // ============================================================

      if (
        userMessage.includes("全部忘れて") ||
        userMessage.includes("全部忘れろ") ||
        userMessage.includes("記憶消して")
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
        userMessage.includes("覚え") ||
        userMessage.includes("記憶して") ||
        userMessage.includes("忘れないで") ||
        userMessage.includes("忘れんで");

      if (shouldRemember) {
        const extracted =
          extractMemories(
            userMessage
          );

        for (const item of extracted) {
          memories =
            upsertMemory(
              memories,
              item
            );
        }

        if (extracted.length > 0) {
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

      let searchData = null;

      if (searchDecision.search) {
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

        if (
          !searchData ||
          !Array.isArray(
            searchData.results
          ) ||
          searchData.results.length === 0
        ) {
          const reply =
            "ごめん、検索結果がうまく取れんかった💦";

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

      const japanNow =
        getJapanDateTime();

      let systemPrompt = "";
      let aiHistory = [];

      // ============================================================
      // Web検索回答
      // ============================================================

      if (searchDecision.search) {
        const sourcesText =
          searchData.results
            .slice(0, 6)
            .map(
              (item, index) => `
【検索資料 ${index + 1}】

タイトル:
${item.title}

公開・更新日:
${item.publishedDate || "不明"}

コード側の開催期間判定:
${item.temporalInfo || "開催期間を自動判定できる記載なし"}

内容:
${item.content}
`
            )
            .join("\n");

        systemPrompt = `
あなたの名前は「ちゃぴ」。
LINEで話す明るく親しみやすい博多の女の子です。

現在の日本時間:
${japanNow}

今回の質問はWeb検索済みです。


【最重要】

検索資料だけを根拠に回答してください。

モデル自身の古い知識、
過去の会話、
ユーザーの個人情報を
検索回答に混ぜてはいけません。

検索資料にない
日付、報酬、性能、仕様を
想像して追加してはいけません。


【コード側の開催期間判定】

各検索資料には、

「コード側の開催期間判定」

が付いている場合があります。

この判定は、
現在の日本時間と、
資料に書かれた開催期間を
プログラム側で比較した結果です。

「開始前」
と書いてあれば、
絶対に「開催中」と言ってはいけません。

「終了済み」
と書いてあれば、
絶対に「開催中」と言ってはいけません。

「開催中」
と書いてあるものだけを、
現在開催中として扱ってください。


【25:00表記】

8月12日 25:00 は、
8月13日 午前1:00です。

24:59は、
翌日の午前0:59です。

コード側ではこの変換を済ませています。


【最新情報】

「今」
「現在」
「最新」
「今来てる」
「開催中」

と聞かれた場合は、

古いイベントを
現在開催中として紹介しないでください。

開始前イベントは
「これから始まるイベント」

終了済みは
「終了済み」

と分けてください。


【情報が食い違う場合】

資料同士で開催期間や数字が違う場合は、

「情報によって表記が違っとる」

と伝えてください。

公式情報、
より新しい情報、
コード側の期間判定を優先してください。


【ダダサバイバー】

ダダサバイバーとSurvivor.ioは
同じゲームとして扱って構いません。

以下の質問では
検索資料を比較してください。

・イベント
・イベント交換
・S級軍備
・装備
・サバイバー
・キャラ
・コレクション
・欠片
・テックパーツ
・ペット
・覚醒
・無課金攻略
・ギフトコード
・アップデート


【攻略相談】

「何が一番強い？」
「どれがおすすめ？」
「何を交換？」
「無課金なら？」
「何を育てる？」
「どっちがいい？」

などの場合は、
最初に結論を答えてください。

例:

「無課金なら○○を優先するのがおすすめばい👌」

そのあと理由を短く説明してください。

資料だけでは判断不能なら、

「今の検索資料だけでは断定できん」

と答えてください。


【話し方】

・自分のことは「ちゃぴ」
・「俺」「僕」は使わない
・自然な博多弁
・友達とのLINEのように話す
・長すぎない
・毎回無理に質問で終わらせない
・絵文字は少しだけ


【禁止する関西弁】

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


【URL】

URLは本文に書かないでください。

参考URLはプログラム側で付けます。


【検索資料】

${sourcesText}
`;

      // ============================================================
      // 普通の会話
      // ============================================================

      } else {
        const relevant =
          selectRelevantMemories(
            userMessage,
            memories
          );

        const memoryText =
          relevant.length > 0
            ? relevant
                .map(memoryToText)
                .join("\n")
            : "なし";

        systemPrompt = `
あなたの名前は「ちゃぴ」。

LINEにいる、
明るく親しみやすい博多の女の子です。

友達とのLINEのように自然に話してください。

・自分のことは「ちゃぴ」
・「俺」「僕」は使わない
・自然な博多弁
・雑談は短め
・絵文字は少しだけ
・知らないことを作らない
・毎回無理に質問で終わらせない
・関西弁は禁止

今回使ってよい長期記憶:

${memoryText}

記憶にないことを
覚えているふりしてはいけません。

ユーザーが聞いていない記憶を
突然話題に出してはいけません。
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

      let rawAI = null;

      try {
        rawAI =
          await runAI(
            messages,
            env,
            searchDecision.search
              ? 1800
              : 1100,
            searchDecision.search
              ? 0.1
              : 0.45
          );
      } catch (error) {
        console.error(
          "AI RUN ERROR:",
          error
        );
      }

      let replyText =
        extractAIText(
          rawAI
        );

      // ============================================================
      // Qwen reasoning対策
      // ============================================================

      if (!replyText) {
        try {
          const retry =
            await runAI(
              [
                {
                  role: "system",
                  content:
                    "思考過程は出力せず、日本語の最終回答だけ返してください。",
                },
                {
                  role: "user",
                  content:
                    searchDecision.search
                      ? `
現在の日本時間:
${japanNow}

質問:
${userMessage}

以下の検索資料だけを使って答えてください。

コード側で「開始前」と判定されたイベントは開催中と言わないでください。

${searchData.results
  .slice(0, 5)
  .map(
    (item, index) => `
資料${index + 1}

タイトル:
${item.title}

開催期間判定:
${item.temporalInfo || "なし"}

内容:
${item.content}
`
  )
  .join("\n")}
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

        if (urls.length > 0) {
          lineReply +=
            "\n\n🔎 参考\n" +
            urls
              .map(
                (url, index) =>
                  `${index + 1}. ${url}`
              )
              .join("\n");
        }
      }

      await saveHistory(
        env,
        historyKey,
        history,
        userMessage,
        replyText
      );

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

function decideSearch(message) {
  const text =
    String(
      message || ""
    ).trim();

  const lower =
    text.toLowerCase();

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

  const survivorTerms = [
    "ダダサバ",
    "ダダサバイバー",
    "survivor.io",
    "s級軍備",
    "s級装備",
    "メモリーエディター",
    "キティース",
    "タローシア",
    "ヴァルカン",
    "コレクション",
    "テックパーツ",
  ];

  if (
    survivorTerms.some(
      term =>
        lower.includes(
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
    "開催中",
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
// 検索語
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
      .replace(
        /について/g,
        " "
      )
      .replace(
        /\s+/g,
        " "
      )
      .trim();

  if (isSurvivor) {
    const now =
      getJapanDateParts();

    if (
      !text
        .toLowerCase()
        .includes("survivor.io")
    ) {
      text +=
        " Survivor.io";
    }

    if (
      text.includes("今") ||
      text.includes("最新") ||
      text.includes("イベント") ||
      text.includes("開催")
    ) {
      text +=
        ` ${now.year}年${now.month}月`;
    }
  }

  return text.slice(
    0,
    300
  );
}


// ============================================================
// Web検索
// ============================================================

async function searchWeb(query, env) {
  if (!env.TAVILY_API_KEY) {
    throw new Error(
      "TAVILY_API_KEY が設定されていません"
    );
  }

  const survivor =
    isSurvivorQuery(
      query
    );

  const now =
    getJapanDateParts();

  const cacheKey =
    `search:v70:${simpleHash(query)}`;

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
        parsed.results.length > 0
      ) {
        return parsed;
      }
    }
  } catch (error) {
    console.error(
      "SEARCH CACHE ERROR:",
      error
    );
  }

  const queries = [
    query,
  ];

  if (survivor) {
    queries.push(
      `ダダサバイバー ${now.year}年${now.month}月 イベント 最新`
    );

    queries.push(
      `Survivor.io ${getEnglishMonth(now.month)} ${now.year} event`
    );
  }

  const responses =
    await Promise.all(
      queries.map(
        async q => {
          try {
            return await callTavily(
              q,
              env
            );
          } catch (error) {
            console.error(
              "TAVILY ERROR:",
              q,
              error
            );

            return {
              results: [],
            };
          }
        }
      )
    );

  let rawResults = [];

  for (const response of responses) {
    if (
      Array.isArray(
        response?.results
      )
    ) {
      rawResults =
        mergeResults(
          rawResults,
          response.results
        );
    }
  }

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
      )
      .map(
        item => {
          const content =
            String(
              item.content || ""
            ).slice(
              0,
              2400
            );

          return {
            title:
              String(
                item.title || ""
              ),

            url:
              String(
                item.url || ""
              ),

            content,

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

            temporalInfo:
              buildTemporalInfo(
                `${item.title || ""}\n${content}`
              ),

            rankScore:
              calculateRankScore(
                item,
                query,
                survivor,
                now
              ),
          };
        }
      );

  results.sort(
    (a, b) =>
      b.rankScore -
      a.rankScore
  );

  const selected = [];
  const domainCounts =
    new Map();

  for (const item of results) {
    const domain =
      getDomain(
        item.url
      );

    const count =
      domainCounts.get(
        domain
      ) || 0;

    if (count >= 2) {
      continue;
    }

    selected.push(
      item
    );

    domainCounts.set(
      domain,
      count + 1
    );

    if (
      selected.length >= 8
    ) {
      break;
    }
  }

  const finalResults =
    selected.map(
      item => ({
        title:
          item.title,

        url:
          item.url,

        content:
          item.content,

        score:
          item.score,

        publishedDate:
          item.publishedDate,

        temporalInfo:
          item.temporalInfo,
      })
    );

  const result = {
    query,

    results:
      finalResults,

    searchedAt:
      new Date()
        .toISOString(),
  };

  if (
    finalResults.length > 0
  ) {
    try {
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
    } catch (error) {
      console.error(
        "SEARCH CACHE WRITE ERROR:",
        error
      );
    }
  }

  return result;
}


// ============================================================
// Tavily
// ============================================================

async function callTavily(query, env) {
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

            exclude_domains: [
              "xvideos.com",
              "xhamster.com",
              "pornhub.com",
              "xnxx.com",
              "redtube.com",
              "youporn.com",
              "spankbang.com",
              "onlyfans.com",
              "search.yahoo.co.jp",
            ],
          }),
      }
    );

  const body =
    await response.text();

  if (!response.ok) {
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
// 開催期間をコード側で判定
// ============================================================

function buildTemporalInfo(text) {
  const ranges =
    extractJapaneseDateRanges(
      text
    );

  if (
    ranges.length === 0
  ) {
    return "";
  }

  const nowMs =
    Date.now();

  const lines =
    ranges
      .slice(0, 4)
      .map(
        range => {
          let status = "";

          if (
            nowMs <
            range.startMs
          ) {
            status =
              "開始前";

          } else if (
            nowMs >
            range.endMs
          ) {
            status =
              "終了済み";

          } else {
            status =
              "開催中";
          }

          return (
            `${status} | ` +
            `開始: ${range.startLabel} | ` +
            `終了: ${range.endLabel}`
          );
        }
      );

  return lines.join(
    "\n"
  );
}


// ============================================================
// 日本語の日付範囲抽出
// ============================================================

function extractJapaneseDateRanges(text) {
  const value =
    String(
      text || ""
    );

  const current =
    getJapanDateParts();

  const results = [];

  // ============================================================
  // 時刻あり
  // 8月12日(水)25:00 ～ 8月17日(月)24:59
  // ============================================================

  const timeRegex =
    /(\d{1,2})月(\d{1,2})日(?:\([^)]*\))?\s*(\d{1,2})[:：](\d{2})\s*[~〜～\-－―]\s*(?:(\d{1,2})月)?(\d{1,2})日(?:\([^)]*\))?\s*(\d{1,2})[:：](\d{2})/g;

  for (
    const match of value.matchAll(
      timeRegex
    )
  ) {
    const startMonth =
      Number(
        match[1]
      );

    const startDay =
      Number(
        match[2]
      );

    const startHour =
      Number(
        match[3]
      );

    const startMinute =
      Number(
        match[4]
      );

    const endMonth =
      Number(
        match[5] ||
        startMonth
      );

    const endDay =
      Number(
        match[6]
      );

    const endHour =
      Number(
        match[7]
      );

    const endMinute =
      Number(
        match[8]
      );

    let startYear =
      current.year;

    let endYear =
      current.year;

    if (
      endMonth <
      startMonth
    ) {
      endYear++;
    }

    const startMs =
      jstToUtcMs(
        startYear,
        startMonth,
        startDay,
        startHour,
        startMinute
      );

    const endMs =
      jstToUtcMs(
        endYear,
        endMonth,
        endDay,
        endHour,
        endMinute
      );

    results.push({
      startMs,
      endMs,

      startLabel:
        formatJstTimestamp(
          startMs
        ),

      endLabel:
        formatJstTimestamp(
          endMs
        ),
    });
  }

  // ============================================================
  // 日付だけ
  // 8月12日～8月17日
  // ============================================================

  const dateRegex =
    /(\d{1,2})月(\d{1,2})日(?:\([^)]*\))?\s*[~〜～\-－―]\s*(?:(\d{1,2})月)?(\d{1,2})日(?:\([^)]*\))?/g;

  for (
    const match of value.matchAll(
      dateRegex
    )
  ) {
    const fullText =
      match[0];

    // 時刻ありは二重登録しない
    if (
      /[:：]\d{2}/.test(
        fullText
      )
    ) {
      continue;
    }

    const startMonth =
      Number(
        match[1]
      );

    const startDay =
      Number(
        match[2]
      );

    const endMonth =
      Number(
        match[3] ||
        startMonth
      );

    const endDay =
      Number(
        match[4]
      );

    let startYear =
      current.year;

    let endYear =
      current.year;

    if (
      endMonth <
      startMonth
    ) {
      endYear++;
    }

    const startMs =
      jstToUtcMs(
        startYear,
        startMonth,
        startDay,
        0,
        0
      );

    const endMs =
      jstToUtcMs(
        endYear,
        endMonth,
        endDay,
        23,
        59
      );

    results.push({
      startMs,
      endMs,

      startLabel:
        formatJstTimestamp(
          startMs
        ),

      endLabel:
        formatJstTimestamp(
          endMs
        ),
    });
  }

  // 重複除去
  const map =
    new Map();

  for (const item of results) {
    const key =
      `${item.startMs}:${item.endMs}`;

    if (!map.has(key)) {
      map.set(
        key,
        item
      );
    }
  }

  return [
    ...map.values(),
  ];
}


// ============================================================
// JST日時 → UTCミリ秒
//
// 25:00などもDate.UTCが自動で翌日にしてくれる
// ============================================================

function jstToUtcMs(
  year,
  month,
  day,
  hour,
  minute
) {
  return Date.UTC(
    year,
    month - 1,
    day,
    hour - 9,
    minute,
    0
  );
}


// ============================================================
// JST日時表示
// ============================================================

function formatJstTimestamp(ms) {
  return new Intl.DateTimeFormat(
    "ja-JP",
    {
      timeZone:
        "Asia/Tokyo",

      year:
        "numeric",

      month:
        "2-digit",

      day:
        "2-digit",

      hour:
        "2-digit",

      minute:
        "2-digit",

      hourCycle:
        "h23",
    }
  ).format(
    new Date(ms)
  );
}


// ============================================================
// 検索順位
// ============================================================

function calculateRankScore(
  item,
  query,
  survivor,
  now
) {
  const text =
    `${item?.title || ""} ${item?.content || ""}`
      .toLowerCase();

  let score =
    typeof item?.score ===
      "number"
      ? item.score * 4
      : 0;

  const domain =
    getDomain(
      item?.url || ""
    );

  const highestTrust = [
    "play.google.com",
    "habby.com",
    "survivor.io",
    "nintendo.com",
    "nintendo.co.jp",
  ];

  const highTrust = [
    "game8.jp",
    "gamewith.jp",
    "famitsu.com",
    "4gamer.net",
  ];

  if (
    highestTrust.some(
      trusted =>
        domain === trusted ||
        domain.endsWith(
          `.${trusted}`
        )
    )
  ) {
    score += 6;
  }

  if (
    highTrust.some(
      trusted =>
        domain === trusted ||
        domain.endsWith(
          `.${trusted}`
        )
    )
  ) {
    score += 4;
  }

  if (survivor) {
    if (
      text.includes(
        "ダダサバ"
      )
    ) {
      score += 5;
    }

    if (
      text.includes(
        "survivor.io"
      )
    ) {
      score += 5;
    }

    if (
      query.includes("イベント") &&
      (
        text.includes("イベント") ||
        text.includes("event")
      )
    ) {
      score += 3;
    }

    if (
      text.includes(
        `${now.year}年${now.month}月`
      )
    ) {
      score += 6;
    }

    if (
      text.includes(
        String(
          now.year
        )
      )
    ) {
      score += 3;
    }
  }

  for (
    let year = 2022;
    year < now.year;
    year++
  ) {
    if (
      text.includes(
        String(
          year
        )
      )
    ) {
      score -=
        (
          now.year -
          year
        ) * 1.5;
    }
  }

  return score;
}


// ============================================================
// ダダサ判定
// ============================================================

function isSurvivorQuery(text) {
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
// 安全フィルター
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
    "search.yahoo.co.jp",
  ];

  return !blocked.some(
    domain =>
      url.includes(
        domain
      )
  );
}


// ============================================================
// 検索結果結合
// ============================================================

function mergeResults(first, second) {
  const map =
    new Map();

  for (
    const item of [
      ...(first || []),
      ...(second || []),
    ]
  ) {
    if (!item?.url) {
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
  maxTokens = 1000,
  temperature = 0.4
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
// AI返答取得
// ============================================================

function extractAIText(response) {
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
    typeof content === "string" &&
    content.trim()
  ) {
    return content.trim();
  }

  if (
    typeof response?.response ===
      "string" &&
    response.response.trim()
  ) {
    return response.response.trim();
  }

  if (
    typeof response
      ?.result
      ?.response === "string" &&
    response
      .result
      .response
      .trim()
  ) {
    return (
      response
        .result
        .response
        .trim()
    );
  }

  return "";
}


// ============================================================
// 記憶抽出
// ============================================================

function extractMemories(text) {
  const result = [];

  const now =
    new Date()
      .toISOString();

  const name =
    text.match(
      /(?:俺|私|僕)の名前は[「『]?([^、。！!？?\s]+?)[」』]?(?:って|と)?覚え/
    );

  if (name?.[1]) {
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

  const nicknamePatterns = [
    /呼び方は[「『]?([^、。！!？?\s]+?)[」』]?(?:でいい|でよい|にして|って)/,
    /[「『]?([^、。！!？?\s]+?)[」』]?(?:って|と)呼んで/,
  ];

  for (
    const pattern of nicknamePatterns
  ) {
    const match =
      text.match(
        pattern
      );

    if (match?.[1]) {
      result.push({
        type:
          "profile",

        key:
          "nickname",

        value:
          cleanMemoryValue(
            match[1]
          ),

        savedAt:
          now,
      });

      break;
    }
  }

  const food =
    text.match(
      /好きな食べ物(?:は|が)[「『]?([^、。！!？?\n]+?)[」』]?(?:って|と)?覚え/
    );

  if (food?.[1]) {
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

    const foodMatch =
      text.match(
        /好きな食べ物(?:は|が)?[「『]?([^、。！!？?\n]+?)[」』]?(?:って|と)?(?:覚え|記憶|$)/
      );

    if (foodMatch?.[1]) {
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

      changed = true;

      continue;
    }

    const extracted =
      extractMemories(
        text
      );

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

function buildSavedReply(items) {
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

  return (
    item?.value ||
    ""
  );
}


// ============================================================
// 関連記憶
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
        item.key === "name" ||
        item.key === "nickname"
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
// 記憶文字整形
// ============================================================

function cleanMemoryValue(value) {
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


function cleanFoodValue(value) {
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
// 返答整形
// ============================================================

function cleanReply(text) {
  return String(
    text || ""
  )
    .replace(
      /<think>[\s\S]*?<\/think>/gi,
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
// LINE
// ============================================================

async function replyToLine(
  replyToken,
  text,
  env
) {
  if (!replyToken) {
    return;
  }

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
                    text || ""
                  ).slice(
                    0,
                    5000
                  ),
              },
            ],
          }),
      }
    );

  if (!response.ok) {
    console.error(
      "LINE ERROR:",
      response.status,
      await response.text()
    );
  }
}


// ============================================================
// 日本時間
// ============================================================

function getJapanDateParts() {
  const formatter =
    new Intl.DateTimeFormat(
      "ja-JP",
      {
        timeZone:
          "Asia/Tokyo",

        year:
          "numeric",

        month:
          "numeric",

        day:
          "numeric",
      }
    );

  const parts =
    formatter.formatToParts(
      new Date()
    );

  const get =
    type =>
      Number(
        parts.find(
          item =>
            item.type ===
            type
        )?.value ||
        0
      );

  return {
    year:
      get("year"),

    month:
      get("month"),

    day:
      get("day"),
  };
}


function getJapanDateTime() {
  return new Intl.DateTimeFormat(
    "ja-JP",
    {
      timeZone:
        "Asia/Tokyo",

      year:
        "numeric",

      month:
        "2-digit",

      day:
        "2-digit",

      weekday:
        "short",

      hour:
        "2-digit",

      minute:
        "2-digit",

      hourCycle:
        "h23",
    }
  ).format(
    new Date()
  );
}


function getEnglishMonth(month) {
  const months = [
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
  ];

  return (
    months[
      Math.max(
        0,
        Math.min(
          11,
          month - 1
        )
      )
    ] ||
    ""
  );
}


// ============================================================
// その他
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


function simpleHash(text) {
  const value =
    String(
      text || ""
    );

  let hash =
    2166136261;

  for (
    let i = 0;
    i < value.length;
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
