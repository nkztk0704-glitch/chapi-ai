export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ============================================================
    // Tavily単体テスト
    // ============================================================

    if (
      request.method === "GET" &&
      url.searchParams.get("check") === "tavily"
    ) {
      try {
        const result = await searchTavily(
          "ダダサバイバー 今来てるイベント",
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
    // AI単体テスト
    // ============================================================

    if (
      request.method === "GET" &&
      url.searchParams.get("check") === "ai"
    ) {
      try {
        const aiResponse = await env.AI.run(
          "@cf/qwen/qwen3-30b-a3b-fp8",
          {
            messages: [
              {
                role: "system",
                content:
                  "日本語で短く答えてください。思考過程は出さず、最終回答だけ返してください。",
              },
              {
                role: "user",
                content:
                  "「AIテスト成功」とだけ返してください。",
              },
            ],
            max_tokens: 150,
            temperature: 0,
          }
        );

        return jsonResponse({
          success: true,
          model:
            "@cf/qwen/qwen3-30b-a3b-fp8",
          extracted:
            extractAIText(aiResponse),
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
    // 通常アクセス
    // ============================================================

    if (request.method !== "POST") {
      return new Response(
        "ちゃぴAI is running!"
      );
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


// ============================================================
// LINEイベント処理
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
                type: "general",

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

      let searched = false;
      let webContext = "";
      let sourceUrls = [];

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
            searchResult.results.length > 0
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
      // 超重要
      //
      // 検索するべき質問なのに検索結果が取れなかった場合、
      // AI自身の知識では絶対に回答させない
      // ============================================================

      if (
        searchDecision.search &&
        !searched
      ) {
        const replyText =
          isDadaSurvivorQuery(
            userMessage
          )
            ? "ごめん💦 今ダダサバイバーの情報を検索で確認できんかったけん、適当なことは言わんようにしとくね。もう一回聞いてみて🙏"
            : "ごめん💦 今うまく検索結果を確認できんかった。適当なことは言わんようにしとくね🙏";

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

      // ============================================================
      // 現在日時
      // ============================================================

      const now =
        new Date();

      const jstNow =
        new Date(
          now.getTime() +
          9 * 60 * 60 * 1000
        );

      const currentJst =
        formatJstForPrompt(
          jstNow
        );

      // ============================================================
      // 普通の会話だけ記憶・履歴を使用
      // ============================================================

      let memoryContext =
        "なし";

      let historyForAI = [];

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


【現在の日本時間】

${currentJst}


【最重要：検索済みの場合】

今回Web検索済みなら、
必ず下の検索資料だけを根拠に答えてください。

モデル自身が学習時に覚えた知識は、
事実確認には使ってはいけません。

検索資料に書かれていない

・キャラクター名
・サバイバー名
・武器名
・装備名
・スキル名
・イベント名
・アイテム名
・報酬名

を勝手に作ってはいけません。

検索資料に存在しない固有名詞を
新しく回答へ追加してはいけません。

検索資料で確認できない場合は、

「検索資料では確認できんかった」

と答えてください。


【ダダサバイバーの超重要ルール】

ユーザーが
ダダサバイバーについて質問している場合は、
検索資料だけを使ってください。

特に、

「強いサバイバー」
「最強サバイバー」
「おすすめキャラ」
「強い武器」
「最強装備」
「S級軍備」
「何を育てる？」
「何を交換？」
「無課金なら？」
「どっちがいい？」
「どれが強い？」

などの質問では、
必ず検索資料を比較して答えてください。

検索資料に
ランキングや評価が書いていない場合は、
勝手にランキングを作ってはいけません。

その場合は、

「今回の検索資料だけでは一番強いとは断定できん」

と答えてください。


【攻略判断】

ユーザーが
おすすめや順位を聞いた場合は、

最初に短く結論を答えてください。

そのあと、
検索資料にある理由だけ説明してください。

例:

「今の検索資料を見る限り、○○がかなり評価高いばい👌」

検索資料にない理由を
追加してはいけません。


【日時判定の最重要ルール】

イベントについて
「開催中」
「今やっている」
「始まっている」
「終了した」
「まだ始まっていない」
と判断する場合は、
必ず上の現在の日本時間と
検索資料にある開催日時を比較してください。

未来のイベントを
「開催中」と言ってはいけません。

開始日時を過ぎていて、
終了日時を過ぎていない場合だけ
「開催中」と言ってください。

開始日時より前なら
「まだ開始前」

終了日時を過ぎている場合は
「終了済み」

と答えてください。


【25:00などの時刻表記】

ゲーム攻略サイトでは、

8月12日25:00
=
8月13日01:00

です。

24:00 = 翌日00:00
25:00 = 翌日01:00
26:00 = 翌日02:00

として計算してください。


【同じイベントで日時情報が食い違う場合】

同じイベントについて、

「8月12日〜8月17日」

と、

「8月12日25:00〜8月17日24:59」

の両方がある場合は、

必ず
時刻まで書かれた情報を優先してください。


【現在開催中イベントを聞かれた場合】

開始前イベントを
現在開催中として紹介してはいけません。

開始前なら、

「次に始まるイベント」

として分けてください。

現在開催中だと確認できる
期間限定イベントがなければ、

「今の時点では開催中の期間限定イベントは確認できんかった」

と答えてください。


【Web検索済みの場合】

今回Web検索済みなら、
検索資料だけを使って
事実関係を回答してください。

あなた自身の古い知識を
追加してはいけません。

過去の会話内容や
ユーザーの名前・好み・記憶を
検索回答に混ぜてはいけません。


【最新情報】

「最新」
「現在」
「今」
と聞かれた場合は、

昔の記事を
現在の情報として説明してはいけません。

現在日時に近い情報を優先してください。


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
  : "Web検索なし"}


【検索資料】

${webContext || "なし"}
`;

      const messages = [
        {
          role: "system",
          content:
            systemPrompt,
        },

        ...historyForAI,

        {
          role: "user",
          content:
            userMessage,
        },
      ];

      // ============================================================
      // AI
      // ============================================================

      const aiResponse =
        await env.AI.run(
          "@cf/qwen/qwen3-30b-a3b-fp8",
          {
            messages,

            max_tokens:
              searched
                ? 850
                : 450,

            temperature:
              searched
                ? 0
                : 0.4,

            repetition_penalty:
              1.1,
          }
        );

      let replyText =
        extractAIText(
          aiResponse
        ) ||
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
              (url, i) =>
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
    String(
      message || ""
    ).trim();

  // ============================================================
  // 個人記憶確認は検索しない
  // ============================================================

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

  // ============================================================
  // 超重要
  //
  // ダダサバイバー関連なら
  // 「最新」「調べて」が無くても強制検索
  // ============================================================

  if (
    isDadaSurvivorQuery(
      text
    )
  ) {
    const freshness =
      isCurrentInfoQuestion(
        text
      )
        ? "week"
        : "none";

    return {
      search: true,

      query:
        buildSearchQuery(
          text
        ),

      freshness,
    };
  }

  // ============================================================
  // 一般検索
  // ============================================================

  const searchWords = [
    "調べて",
    "検索して",
    "最新",
    "ニュース",
    "現在",
    "今の",
    "今来てる",
    "今きてる",
    "今やってる",
    "開催中",
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
    isCurrentInfoQuestion(
      text
    )
  ) {
    freshness =
      "week";
  }

  return {
    search: true,

    query:
      buildSearchQuery(
        text
      ),

    freshness,
  };
}


// ============================================================
// ダダサ判定
// ============================================================

function isDadaSurvivorQuery(
  text
) {
  const value =
    String(
      text || ""
    ).toLowerCase();

  const dadaWords = [
    "ダダサバ",
    "ダダサバイバー",
    "survivor.io",
    "survivor io",
    "s級軍備",
    "s級装備",
    "キティース",
    "タローシア",
    "ヴァルカン",
    "テックパーツ",
    "コレクション",
  ];

  return dadaWords.some(
    word =>
      value.includes(
        word.toLowerCase()
      )
  );
}


// ============================================================
// 現在系質問
// ============================================================

function isCurrentInfoQuestion(
  text
) {
  const words = [
    "最新",
    "現在",
    "今の",
    "今来てる",
    "今きてる",
    "今やってる",
    "開催中",
    "今日",
    "イベント",
    "アップデート",
    "最強",
    "強い",
    "おすすめ",
    "ランキング",
  ];

  return words.some(
    word =>
      text.includes(word)
  );
}


// ============================================================
// 検索語
// ============================================================

function buildSearchQuery(text) {
  let cleaned =
    String(text)
      .replace(
        /調べて(教えて)?/g,
        ""
      )
      .replace(
        /検索して(教えて)?/g,
        ""
      )
      .replace(
        /教えて/g,
        ""
      )
      .trim();

  const current =
    getCurrentJstParts();

  // ============================================================
  // ダダサバイバー
  // ============================================================

  if (
    isDadaSurvivorQuery(
      cleaned
    )
  ) {
    let extra =
      ` Survivor.io ${current.year}年${current.month}月`;

    // イベント
    if (
      cleaned.includes(
        "イベント"
      ) ||
      cleaned.includes(
        "今来てる"
      ) ||
      cleaned.includes(
        "今きてる"
      )
    ) {
      extra +=
        " 最新 イベント 開催期間";
    }

    // キャラ・サバイバー
    if (
      cleaned.includes(
        "サバイバー"
      ) ||
      cleaned.includes(
        "キャラ"
      )
    ) {
      extra +=
        " キャラ サバイバー 評価 ランキング";
    }

    // 強さ
    if (
      cleaned.includes(
        "強い"
      ) ||
      cleaned.includes(
        "最強"
      ) ||
      cleaned.includes(
        "おすすめ"
      )
    ) {
      extra +=
        " 最強 おすすめ ランキング 評価";
    }

    // 装備
    if (
      cleaned.includes(
        "装備"
      ) ||
      cleaned.includes(
        "軍備"
      ) ||
      cleaned.includes(
        "武器"
      )
    ) {
      extra +=
        " 装備 武器 評価 ランキング";
    }

    // 無課金
    if (
      cleaned.includes(
        "無課金"
      )
    ) {
      extra +=
        " 無課金 攻略";
    }

    // 交換
    if (
      cleaned.includes(
        "交換"
      )
    ) {
      extra +=
        " 交換 おすすめ";
    }

    return (
      `${cleaned}${extra}`
        .replace(
          /\s+/g,
          " "
        )
        .trim()
        .slice(
          0,
          300
        )
    );
  }

  return cleaned.slice(
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
    `tavily:v20:${simpleHash(
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
        ) &&
        parsed.results.length > 0
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

  let rawResults = [];

  // ============================================================
  // 優先サイト
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
  // 一般検索も必ず補助で使う
  // ============================================================

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

  // ============================================================
  // 期間指定で少ない場合は期間なし
  // ============================================================

  if (
    rawResults.length < 4 &&
    freshness !== "none"
  ) {
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
        "RETRY SEARCH ERROR:",
        error
      );
    }
  }

  // ============================================================
  // 整理
  // ============================================================

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
              2400
            ),

          score:
            typeof item.score ===
            "number"
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
              `${
                item.title || ""
              } ${
                item.content || ""
              }`
            ),
        })
      )
      .filter(
        item =>
          item.title &&
          item.url &&
          item.score >= 0.18
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
      .slice(0, 7)
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

  if (
    results.length > 0
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
        "CACHE WRITE ERROR:",
        error
      );
    }
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
      "advanced",

    max_results:
      10,

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
// 優先サイト
// ============================================================

function detectPreferredDomains(
  query
) {
  const text =
    String(query)
      .toLowerCase();

  if (
    text.includes(
      "ダダサバイバー"
    ) ||
    text.includes(
      "survivor.io"
    )
  ) {
    return [
      "game8.jp",
      "gamewith.jp",
      "senilog.com",
      "play.google.com",
      "apps.apple.com",
      "habby.com",
      "youtube.com",
    ];
  }

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
    "apps.apple.com",
    "play.google.com",
    "microsoft.com",
    "sony.com",
    "playstation.com",
    "famitsu.com",
    "gamewith.jp",
    "game8.jp",
    "senilog.com",
    "habby.com",
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
        word.length >= 2
    )
    .slice(0, 12);
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
      ...(a || []),
      ...(b || []),
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
// JST
// ============================================================

function formatJstForPrompt(
  jstDate
) {
  const year =
    jstDate.getUTCFullYear();

  const month =
    String(
      jstDate.getUTCMonth() +
      1
    ).padStart(2, "0");

  const day =
    String(
      jstDate.getUTCDate()
    ).padStart(2, "0");

  const hour =
    String(
      jstDate.getUTCHours()
    ).padStart(2, "0");

  const minute =
    String(
      jstDate.getUTCMinutes()
    ).padStart(2, "0");

  return (
    `${year}年${month}月${day}日 ` +
    `${hour}:${minute} JST`
  );
}


function getCurrentJstParts() {
  const now =
    new Date();

  const jst =
    new Date(
      now.getTime() +
      9 * 60 * 60 * 1000
    );

  return {
    year:
      jst.getUTCFullYear(),

    month:
      jst.getUTCMonth() + 1,

    day:
      jst.getUTCDate(),

    hour:
      jst.getUTCHours(),

    minute:
      jst.getUTCMinutes(),
  };
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

  if (
    nickname?.[1]
  ) {
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

  if (
    food?.[1]
  ) {
    result.push({
      type: "preference",

      key:
        "favorite_food",

      value:
        cleanFoodValue(
          food[1]
        ),

      savedAt: now,
    });
  }

  return result;
}


function migrateAllMemories(
  raw
) {
  let result = [];
  let changed = false;

  for (
    const item of raw
  ) {
    if (
      item?.key === "name" ||
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
      extracted.length > 0
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
        type: "general",

        key:
          item?.key ||
          "general_" +
          simpleHash(text),

        value: text,

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
        item.key === "name"
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
    item?.value || ""
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
        item.key === "name" ||
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
    item.key === "name"
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

      content:
        userMessage,
    },

    {
      role: "assistant",

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
// AI回答抽出
// ============================================================

function extractAIText(
  aiResponse
) {
  if (
    !aiResponse
  ) {
    return "";
  }

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

  if (
    typeof aiResponse
      ?.result
      ?.response ===
      "string"
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
// 共通
// ============================================================

function getDomain(
  url
) {
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


function simpleHash(
  text
) {
  let hash =
    2166136261;

  const value =
    String(
      text || ""
    );

  for (
    let i = 0;
    i < value.length;
    i++
  ) {
    hash ^=
      value.charCodeAt(i);

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
