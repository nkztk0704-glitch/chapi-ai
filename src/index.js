export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // =========================================================
    // Tavilyテスト
    // ?check=tavily
    // =========================================================
    if (
      request.method === "GET" &&
      url.searchParams.get("check") === "tavily"
    ) {
      try {
        const result = await searchTavily(
          "Nintendo Switch 2 最新情報",
          {
            freshness: "week",
            latest: true,
            game: "",
          },
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

    // =========================================================
    // AIテスト
    // ?check=ai
    // =========================================================
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
                "日本語で短く答えてください。思考過程は出力せず、最終回答だけ返してください。",
            },
            {
              role: "user",
              content:
                "「AIテスト成功」とだけ答えて。",
            },
          ],
          env,
          120,
          0.3
        );

        return jsonResponse({
          success: true,
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

    // =========================================================
    // 通常アクセス
    // =========================================================
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

      const userMessage = String(
        event.message.text || ""
      ).trim();

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

      // ========================================================
      // 履歴
      // ========================================================

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

      // ========================================================
      // 長期記憶
      // ========================================================

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

      // ========================================================
      // 全記憶削除
      // ========================================================

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

      // ========================================================
      // 記憶保存
      // ========================================================

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
            upsertMemory(
              memories,
              item
            );
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

      // ========================================================
      // 名前・呼び方
      // ========================================================

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

      // ========================================================
      // 好きな食べ物
      // ========================================================

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

      // ========================================================
      // 検索判定
      // ========================================================

      const decision =
        decideWhetherToSearch(
          userMessage
        );

      let searched = false;
      let searchFailed = false;
      let webContext = "";
      let sourceUrls = [];
      let searchMeta = null;

      if (decision.search) {
        try {
          const result =
            await searchTavily(
              decision.query,
              decision,
              env
            );

          searchMeta = result;

          if (result.results.length > 0) {
            searched = true;

            webContext =
              result.results
                .map(
                  (item, index) => {
                    return `
【検索資料 ${index + 1}】

タイトル:
${item.title}

URL:
${item.url}

公開・更新日:
${item.publishedDate || "不明"}

内容:
${item.content}
`;
                  }
                )
                .join("\n");

            sourceUrls =
              result.results
                .slice(0, 3)
                .map(item => item.url)
                .filter(Boolean);
          } else {
            searchFailed = true;
          }
        } catch (error) {
          searchFailed = true;

          console.error(
            "SEARCH ERROR:",
            error
          );
        }
      }

      // ========================================================
      // 検索失敗時
      // ========================================================

      if (
        decision.search &&
        searchFailed
      ) {
        const failReply =
          "ごめん、今うまく検索結果を確認できんかった💦 もう一回聞いてみて〜！";

        await saveHistory(
          historyKey,
          history,
          userMessage,
          failReply,
          env
        );

        await replyToLine(
          event.replyToken,
          failReply,
          env
        );

        continue;
      }

      // ========================================================
      // 普通の会話時だけ記憶・履歴をAIへ渡す
      // ========================================================

      let memoryContext = "なし";
      let historyForAI = [];

      if (!decision.search) {
        const relevant =
          selectRelevantMemories(
            userMessage,
            memories
          );

        memoryContext =
          relevant.length > 0
            ? relevant
                .map(memoryToText)
                .join("\n")
            : "なし";

        historyForAI =
          history.slice(-10);
      }

      // ========================================================
      // 検索時プロンプト
      // ========================================================

      let systemPrompt = "";

      if (decision.search) {
        systemPrompt = `
あなたの名前は「ちゃぴ」。

LINEで会話する、
明るく親しみやすい博多の女の子です。

今から回答する質問は
Web検索を実行済みです。


【最重要】

回答は必ず下の「検索資料」だけを根拠にしてください。

モデル自身の古い知識、
過去の会話、
ユーザーの名前、
ユーザーの好きな食べ物、
ユーザーの個人情報は
一切混ぜないでください。

検索資料に書かれていない事実を
想像して補完してはいけません。

わからないことは
「検索資料では確認できんかった」
と答えてください。


【最新情報】

今回の質問が最新情報に関する場合、

古い記事を
最新ニュースのように紹介してはいけません。

検索資料に
公開日・更新日がある場合は、
新しい情報を優先してください。

現在の日付は
${new Date().toISOString().slice(0, 10)}
です。

2025年の情報と
2026年の情報がある場合、
内容が同等なら
2026年を優先してください。

ただし、
古い記事でも現在の仕様を説明するために
必要な場合は使用して構いません。

情報が食い違う場合は、
断定せず
「情報が食い違っとる」
と伝えてください。


【ダダサバイバー】

ダダサバイバーについて質問された場合は、

・現在開催中のイベント
・イベント交換
・無課金での優先順位
・S級軍備
・装備
・サバイバー
・コレクション
・欠片
・ペット
・テックパーツ
・覚醒
・アップデート
・攻略

などについて、
検索資料を比較して答えてください。

ユーザーが
「どれが強い？」
「何を交換？」
「どう集める？」
などと聞いた場合は、

最初に結論を短く答え、
その後に理由を説明してください。

無課金について聞かれた場合は
課金前提の方法を最優先にしないでください。


【話し方】

・自分のことは「ちゃぴ」
・「俺」「僕」は使わない
・自然な博多弁
・結論から答える
・長すぎない
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


【URL】

回答本文にはURLを書かないでください。

参考URLは
プログラム側で自動追加します。


【Markdown】

以下は禁止です。

**
#
Markdownリンク


【検索資料】

${webContext}
`;
      }

      // ========================================================
      // 通常会話プロンプト
      // ========================================================

      if (!decision.search) {
        systemPrompt = `
あなたの名前は「ちゃぴ」。

LINEにいる、
明るく親しみやすい博多の女の子です。

友達とのLINEのように
自然に会話してください。


【話し方】

・自分のことは「ちゃぴ」
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


【記憶について】

下に記憶がある場合だけ使用してください。

記憶にない内容を
「覚えている」と言ってはいけません。

ユーザーが聞いていない記憶を
突然話題に出さないでください。


【今回使ってよい記憶】

${memoryContext}


【Markdown禁止】

**
#
Markdownリンク

は禁止です。
`;
      }

      // ========================================================
      // AIメッセージ
      // ========================================================

      const messages = [
        {
          role: "system",
          content: systemPrompt,
        },

        ...historyForAI,

        {
          role: "user",
          content:
            userMessage +
            "\n\n/no_think",
        },
      ];

      // ========================================================
      // AI実行
      // ========================================================

      const aiResponse =
        await runAI(
          messages,
          env,
          decision.search ? 700 : 500,
          decision.search ? 0.2 : 0.6
        );

      let replyText =
        extractAIText(aiResponse);

      if (!replyText) {
        replyText =
          "ごめん、今うまく返事できんかった💦";
      }

      replyText =
        cleanReply(replyText);

      // ========================================================
      // 参考URL
      // ========================================================

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
              (url, index) =>
                `${index + 1}. ${url}`
            )
            .join("\n");
      }

      // ========================================================
      // 履歴保存
      // ========================================================

      await saveHistory(
        historyKey,
        history,
        userMessage,
        replyText,
        env
      );

      // ========================================================
      // LINE返信
      // ========================================================

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

      top_p: 0.8,

      repetition_penalty: 1.05,
    }
  );
}


// ============================================================
// 検索判定
// ============================================================

function decideWhetherToSearch(message) {
  const text =
    String(message || "").trim();

  // 記憶確認は検索しない
  const memoryWords = [
    "覚えてる",
    "覚えとる",
    "覚えてて",
    "覚えといて",
    "記憶して",
    "好きな食べ物",
    "俺の名前",
    "私の名前",
    "僕の名前",
    "呼び方",
    "俺のこと覚え",
    "私のこと覚え",
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
      latest: false,
      game: "",
    };
  }

  // ==========================================================
  // ダダサバ判定
  // ==========================================================

  const survivorWords = [
    "ダダサバ",
    "ダダサバイバー",
    "Survivor.io",
    "survivor.io",
    "S級軍備",
    "s級軍備",
    "メモリーエディター",
    "コレクションの欠片",
    "エクセレントコレクション",
    "エピックコレクション",
    "キティース",
    "タローシア",
  ];

  const isSurvivor =
    survivorWords.some(
      word =>
        text.toLowerCase().includes(
          word.toLowerCase()
        )
    );

  if (isSurvivor) {
    const latest =
      containsLatestIntent(text) ||
      containsChangingGameIntent(text);

    return {
      search: true,

      query:
        buildSurvivorQuery(text),

      freshness:
        latest ? "month" : "none",

      latest,

      game: "survivor",
    };
  }

  // ==========================================================
  // 一般Web検索
  // ==========================================================

  const searchWords = [
    "調べて",
    "検索して",
    "最新",
    "ニュース",
    "現在",
    "今の",
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
    "新作",
    "開催中",
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
      latest: false,
      game: "",
    };
  }

  const latest =
    containsLatestIntent(text);

  let freshness = "none";

  if (
    text.includes("今日") ||
    text.includes("現在") ||
    text.includes("今の")
  ) {
    freshness = "day";
  } else if (
    latest
  ) {
    freshness = "week";
  }

  return {
    search: true,

    query:
      cleanSearchQuery(text),

    freshness,

    latest,

    game: "",
  };
}


// ============================================================
// 最新意図
// ============================================================

function containsLatestIntent(text) {
  const words = [
    "最新",
    "最近",
    "今日",
    "現在",
    "今の",
    "今来てる",
    "今きてる",
    "開催中",
    "ニュース",
    "アップデート",
    "新キャラ",
    "新装備",
    "新イベント",
  ];

  return words.some(
    word =>
      text.includes(word)
  );
}


// ============================================================
// 変化しやすいゲーム情報
// ============================================================

function containsChangingGameIntent(text) {
  const words = [
    "イベント",
    "交換",
    "強い",
    "最強",
    "おすすめ",
    "優先",
    "無課金",
    "入手",
    "集め",
    "軍備",
    "装備",
    "サバイバー",
    "キャラ",
    "コレクション",
    "欠片",
    "覚醒",
    "ペット",
    "テックパーツ",
  ];

  return words.some(
    word =>
      text.includes(word)
  );
}


// ============================================================
// ダダサバ検索語
// ============================================================

function buildSurvivorQuery(text) {
  let cleaned =
    cleanSearchQuery(text);

  if (
    !cleaned.includes("ダダサバイバー") &&
    !cleaned
      .toLowerCase()
      .includes("survivor.io")
  ) {
    cleaned =
      `ダダサバイバー ${cleaned}`;
  }

  return cleaned.slice(0, 300);
}


// ============================================================
// 一般検索語クリーニング
// ============================================================

function cleanSearchQuery(text) {
  return String(text || "")
    .replace(
      /調べて(教えて)?/g,
      ""
    )
    .replace(
      /検索して(教えて)?/g,
      ""
    )
    .replace(
      /教えて$/g,
      ""
    )
    .trim()
    .slice(0, 300);
}


// ============================================================
// Tavily検索
// ============================================================

async function searchTavily(
  query,
  options,
  env
) {
  if (!env.TAVILY_API_KEY) {
    throw new Error(
      "TAVILY_API_KEY が設定されていません"
    );
  }

  const freshness =
    options?.freshness || "none";

  const latest =
    Boolean(options?.latest);

  const game =
    options?.game || "";

  const cacheKey =
    `tavily:v20:${simpleHash(
      `${query}:${freshness}:${latest}:${game}`
    )}`;

  // ==========================================================
  // キャッシュ
  // ==========================================================

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

  const preferredDomains =
    detectPreferredDomains(
      query,
      game
    );

  let rawResults = [];

  // ==========================================================
  // 1. 最新系
  // ==========================================================

  if (latest) {
    const latestResults =
      await callTavily(
        query,
        freshness,
        env,
        [],
        true
      );

    rawResults =
      mergeResults(
        rawResults,
        latestResults
      );
  }

  // ==========================================================
  // 2. 信頼サイト
  // ==========================================================

  if (
    preferredDomains.length > 0
  ) {
    const trusted =
      await callTavily(
        query,
        freshness,
        env,
        preferredDomains,
        false
      );

    rawResults =
      mergeResults(
        rawResults,
        trusted
      );
  }

  // ==========================================================
  // 3. 一般検索
  // ==========================================================

  if (
    rawResults.length < 5
  ) {
    const general =
      await callTavily(
        query,
        freshness,
        env,
        [],
        false
      );

    rawResults =
      mergeResults(
        rawResults,
        general
      );
  }

  // ==========================================================
  // 4. 期間指定で少なすぎる場合
  // ==========================================================

  if (
    rawResults.length < 4 &&
    freshness !== "none"
  ) {
    const fallback =
      await callTavily(
        query,
        "none",
        env,
        preferredDomains,
        false
      );

    rawResults =
      mergeResults(
        rawResults,
        fallback
      );
  }

  // ==========================================================
  // 整形
  // ==========================================================

  const processed =
    rawResults
      .filter(
        item =>
          isSafeSearchResult(item)
      )
      .map(
        item => {
          const publishedDate =
            item.published_date ||
            item.publishedDate ||
            "";

          return {
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
              ).slice(0, 2200),

            score:
              typeof item.score === "number"
                ? item.score
                : 0,

            publishedDate:
              String(
                publishedDate || ""
              ),

            trust:
              trustScore(
                item.url || "",
                preferredDomains,
                game
              ),

            relevance:
              keywordOverlap(
                query,
                `${item.title || ""} ${item.content || ""}`
              ),

            freshnessScore:
              calculateFreshnessScore(
                publishedDate,
                item.title,
                item.content
              ),
          };
        }
      )
      .filter(
        item =>
          item.title &&
          item.url &&
          item.score >= 0.25 &&
          item.relevance > 0
      );

  // ==========================================================
  // 並び替え
  // ==========================================================

  processed.sort(
    (a, b) => {
      const aTotal =
        a.trust * 3 +
        a.relevance * 3 +
        a.score * 2 +
        (
          latest
            ? a.freshnessScore * 4
            : a.freshnessScore
        );

      const bTotal =
        b.trust * 3 +
        b.relevance * 3 +
        b.score * 2 +
        (
          latest
            ? b.freshnessScore * 4
            : b.freshnessScore
        );

      return bTotal - aTotal;
    }
  );

  const results =
    processed
      .slice(0, 6)
      .map(
        item => ({
          title: item.title,
          url: item.url,
          content: item.content,
          score: item.score,
          publishedDate:
            item.publishedDate,
        })
      );

  const result = {
    query,
    results,
    searchedAt:
      new Date().toISOString(),
  };

  // ==========================================================
  // キャッシュ
  // ==========================================================

  try {
    await env.MEMORY.put(
      cacheKey,
      JSON.stringify(result),
      {
        expirationTtl:
          latest ? 300 : 900,
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
  includeDomains,
  newsMode
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

    topic:
      newsMode
        ? "news"
        : "general",

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
    freshness === "month" ||
    freshness === "year"
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

function detectPreferredDomains(
  query,
  game
) {
  const text =
    String(query || "")
      .toLowerCase();

  // ダダサバイバー
  if (
    game === "survivor" ||
    text.includes("ダダサバ") ||
    text.includes("survivor.io")
  ) {
    return [
      "habby.com",
      "game8.jp",
      "gamewith.jp",
      "gamerch.com",
      "wikiwiki.jp",
    ];
  }

  // Nintendo
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

  // PlayStation
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

  // Apple
  if (
    text.includes("iphone") ||
    text.includes("apple")
  ) {
    return [
      "apple.com",
      "support.apple.com",
    ];
  }

  // Microsoft
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
  preferredDomains,
  game
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

  if (game === "survivor") {
    const survivorTrusted = [
      "habby.com",
      "game8.jp",
      "gamewith.jp",
      "gamerch.com",
      "wikiwiki.jp",
    ];

    if (
      survivorTrusted.some(
        trusted =>
          domain === trusted ||
          domain.endsWith(
            `.${trusted}`
          )
      )
    ) {
      return 2;
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
// 新しさスコア
// ============================================================

function calculateFreshnessScore(
  publishedDate,
  title,
  content
) {
  let date = null;

  if (publishedDate) {
    const parsed =
      new Date(publishedDate);

    if (
      !Number.isNaN(
        parsed.getTime()
      )
    ) {
      date = parsed;
    }
  }

  // published_dateがない場合、
  // タイトルや本文の日付を軽く見る
  if (!date) {
    const text =
      `${title || ""} ${content || ""}`;

    const matches =
      [
        ...text.matchAll(
          /(20\d{2})[年\/\-](\d{1,2})[月\/\-](\d{1,2})?/g
        ),
      ];

    let newest = null;

    for (const match of matches) {
      const year =
        Number(match[1]);

      const month =
        Number(match[2]);

      const day =
        Number(match[3] || 1);

      const candidate =
        new Date(
          Date.UTC(
            year,
            month - 1,
            day
          )
        );

      if (
        !newest ||
        candidate > newest
      ) {
        newest = candidate;
      }
    }

    date = newest;
  }

  if (!date) {
    return 0;
  }

  const now =
    new Date();

  const diffMs =
    now.getTime() -
    date.getTime();

  const days =
    diffMs /
    86400000;

  if (days < -30) {
    return 0;
  }

  if (days <= 1) {
    return 5;
  }

  if (days <= 7) {
    return 4;
  }

  if (days <= 30) {
    return 3;
  }

  if (days <= 90) {
    return 2;
  }

  if (days <= 365) {
    return 1;
  }

  return 0;
}


// ============================================================
// 安全判定
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
      word => word.trim()
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
    copy[index] = item;
  } else {
    copy.push(item);
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
// 名前・呼び方確認
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
// 好きな食べ物確認
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


// ============================================================
// 記憶テキスト化
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
// 記憶値クリーニング
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
                    .slice(
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
