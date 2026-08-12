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
      // 旧形式 → 新形式へ自動移行
      // ==========================================

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

            // 旧形式が見つかった場合だけ
            // KVへ新形式を保存し直す
            if (migrated.changed) {
              await env.MEMORY.put(
                memoryKey,
                JSON.stringify(memories)
              );

              console.log(
                "MEMORY MIGRATED:",
                memoryKey,
                JSON.stringify(memories)
              );
            }
          }
        }
      } catch (error) {
        console.error(
          "MEMORY READ/MIGRATION ERROR:",
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
      // 「覚えて」系を構造化して保存
      // ==========================================

      const shouldRemember =
        userMessage.includes("覚え") ||
        userMessage.includes("記憶して") ||
        userMessage.includes("忘れないで") ||
        userMessage.includes("忘れんで");

      let newlySavedMemories = [];

      if (shouldRemember) {
        newlySavedMemories =
          extractMemories(userMessage);

        for (
          const newMemory of newlySavedMemories
        ) {
          memories =
            upsertMemory(
              memories,
              newMemory
            );
        }

        // 構造化できなかった時だけ一般記憶
        if (
          newlySavedMemories.length === 0
        ) {
          memories =
            upsertMemory(
              memories,
              {
                type: "general",
                key:
                  normalizeMemoryKey(
                    userMessage
                  ),
                value:
                  userMessage,
                text:
                  userMessage,
                savedAt:
                  new Date().toISOString()
              }
            );
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

        // プロフィール等はAIに変形させず
        // 保存値そのままで返す
        const savedProfileReply =
          buildSavedProfileReply(
            newlySavedMemories
          );

        if (savedProfileReply) {
          const replyText =
            cleanReply(
              savedProfileReply
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


      // ==========================================
      // 名前・呼び方の質問
      // ==========================================

      const exactProfileReply =
        buildExactProfileReply(
          userMessage,
          memories
        );

      if (exactProfileReply) {
        const replyText =
          cleanReply(
            exactProfileReply
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


      // ==========================================
      // 好きな食べ物の質問
      // ==========================================

      const exactFoodReply =
        buildExactFoodReply(
          userMessage,
          memories
        );

      if (exactFoodReply) {
        const replyText =
          cleanReply(
            exactFoodReply
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


      history =
        history.slice(-16);


      // ==========================================
      // 関係ある長期記憶だけ選択
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
      // Web検索判定
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
      // Web検索時は古いAI回答を使わない
      // ==========================================

      let historyForAI =
        history;

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
      // システムプロンプト
      // ==========================================

      const systemPrompt = `
あなたの名前は「ちゃぴ」。

LINEにいる明るく親しみやすい博多の女の子として、
友達とのLINEのように自然に会話してください。

━━━━━━━━━━━━━━━━━━
【キャラクター】
━━━━━━━━━━━━━━━━━━

・自分の名前は「ちゃぴ」
・自分のことも「ちゃぴ」
・「俺」「僕」は使わない
・明るく自然に話す
・説明マシンのようにならない
・絵文字は少しだけ使う

━━━━━━━━━━━━━━━━━━
【博多弁】
━━━━━━━━━━━━━━━━━━

自然な範囲で、

「〜ばい」
「〜たい」
「〜と？」
「〜けん」
「よかよ」
「〜しとる」
「〜しよった」

などを使ってください。

毎文に方言を入れる必要はありません。

関西弁になるくらいなら
標準語を使ってください。

━━━━━━━━━━━━━━━━━━
【禁止表現】
━━━━━━━━━━━━━━━━━━

以下の関西弁は禁止です。

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
「やったんや」
「〜へん」

━━━━━━━━━━━━━━━━━━
【長期記憶】
━━━━━━━━━━━━━━━━━━

下にある情報だけが
今回使ってよい長期記憶です。

関係ない記憶を勝手に持ち出さないでください。

名前の話題で
食べ物の話を突然出してはいけません。

食べ物の話題で
名前の話を突然出してはいけません。

保存されている名前・呼び方・固有名詞は
一文字も勝手に変えないでください。

━━━━━━━━━━━━━━━━━━
【Web検索】
━━━━━━━━━━━━━━━━━━

Web検索済みの場合は、
過去の知識や過去のAI回答より
今回の検索資料を優先してください。

検索資料にないことを作らないでください。

特に、

・発売日
・価格
・日付
・数字
・仕様
・イベント
・発表内容

は資料で確認できる場合だけ答えてください。

検索資料がない場合は、
最新情報を知ったふりをしないでください。

回答本文にURLを書かないでください。

━━━━━━━━━━━━━━━━━━
【Markdown禁止】
━━━━━━━━━━━━━━━━━━

LINEなので、

**
#
[文字](URL)

などのMarkdown記法は禁止です。

━━━━━━━━━━━━━━━━━━
【今回使ってよい長期記憶】
━━━━━━━━━━━━━━━━━━

${relevantMemoryText}

━━━━━━━━━━━━━━━━━━
【Web検索状態】
━━━━━━━━━━━━━━━━━━

${searched ? "Web検索済み" : "Web検索なし"}

━━━━━━━━━━━━━━━━━━
【検索資料】
━━━━━━━━━━━━━━━━━━

${webContext || "なし"}
`;


      // ==========================================
      // AI問い合わせ
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

            max_tokens:
              650,

            temperature:
              searched
                ? 0.2
                : 0.35,

            repetition_penalty:
              1.1
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


      // ==========================================
      // LINE表示用URL
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

      await saveHistory(
        historyKey,
        history,
        userMessage,
        replyText,
        env
      );


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
// 旧記憶 → 新記憶 自動移行
// ==============================================

function migrateAllMemories(rawMemories) {
  let changed = false;
  let result = [];

  for (
    const raw of rawMemories
  ) {
    // すでに新形式ならそのまま
    if (
      raw &&
      typeof raw === "object" &&
      raw.key &&
      raw.type
    ) {
      result =
        upsertMemory(
          result,
          raw
        );

      continue;
    }

    const text =
      typeof raw === "string"
        ? raw
        : String(
            raw?.text || ""
          );

    const savedAt =
      raw?.savedAt ||
      new Date().toISOString();


    // ==========================================
    // 旧形式から名前抽出
    // ==========================================

    const nameMatch =
      text.match(
        /(?:俺|私|僕)?の?名前は[「『]?([^、。！!？?\s]+?)[」』]?(?:って|と)?(?:覚え|記憶|忘れ)/
      );

    if (
      nameMatch?.[1]
    ) {
      const value =
        cleanMemoryValue(
          nameMatch[1]
        );

      result =
        upsertMemory(
          result,
          {
            type: "profile",
            key: "name",
            value,
            text:
              `名前は${value}`,
            savedAt
          }
        );

      changed = true;
    }


    // ==========================================
    // 旧形式から呼び方抽出
    // ==========================================

    const nicknamePatterns = [
      /呼び方は[「『]?([^、。！!？?\s]+?)[」』]?(?:でいい|でよい|にして|って)/,
      /[「『]?([^、。！!？?\s]+?)[」』]?(?:って|と)呼んで/,
      /呼ぶ時は[「『]?([^、。！!？?\s]+?)[」』]?/
    ];

    for (
      const pattern of nicknamePatterns
    ) {
      const match =
        text.match(pattern);

      if (
        match?.[1]
      ) {
        const value =
          cleanMemoryValue(
            match[1]
          );

        result =
          upsertMemory(
            result,
            {
              type: "profile",
              key: "nickname",
              value,
              text:
                `呼び方は${value}`,
              savedAt
            }
          );

        changed = true;
        break;
      }
    }


    // ==========================================
    // 旧形式から好きな食べ物抽出
    // ==========================================

    const foodPatterns = [
      /好きな食べ物は[「『]?([^、。！!？?\n]+?)[」』]?(?:って|と)?覚え/,
      /好きな食べ物は[「『]?([^、。！!？?\n]+?)[」』]?(?:って|と)?記憶/,
      /好きな食べ物(?:が|は)[「『]?([^、。！!？?\n]+?)[」』]?(?:です|だよ|だ)(?:って)?/
    ];

    let foodFound = false;

    for (
      const pattern of foodPatterns
    ) {
      const match =
        text.match(pattern);

      if (
        match?.[1]
      ) {
        const value =
          cleanMemoryValue(
            match[1]
          );

        result =
          upsertMemory(
            result,
            {
              type:
                "preference",
              key:
                "favorite_food",
              value,
              text:
                `好きな食べ物は${value}`,
              savedAt
            }
          );

        changed = true;
        foodFound = true;

        break;
      }
    }


    // ==========================================
    // 何にも変換できなかった記憶は保持
    // ==========================================

    const converted =
      Boolean(nameMatch?.[1]) ||
      foodFound ||
      nicknamePatterns.some(
        pattern =>
          pattern.test(text)
      );

    if (!converted) {
      result.push({
        type:
          "general",

        key:
          normalizeMemoryKey(
            text
          ),

        value:
          text,

        text,

        savedAt
      });

      // 旧形式だったなら新形式へしたのでchanged
      changed = true;
    }
  }

  return {
    memories:
      result.slice(-50),

    changed
  };
}


// ==============================================
// 履歴保存
// ==============================================

async function saveHistory(
  historyKey,
  history,
  userMessage,
  replyText,
  env
) {
  const newHistory = [
    ...history,

    {
      role:
        "user",

      content:
        userMessage
    },

    {
      role:
        "assistant",

      content:
        replyText
    }

  ].slice(-16);

  try {
    await env.MEMORY.put(
      historyKey,
      JSON.stringify(
        newHistory
      )
    );
  } catch (error) {
    console.error(
      "HISTORY WRITE ERROR:",
      error
    );
  }
}


// ==============================================
// 新しい「覚えて」発言を構造化
// ==============================================

function extractMemories(text) {
  const results = [];

  const now =
    new Date().toISOString();


  // ==========================================
  // 名前
  // ==========================================

  const namePatterns = [
    /(?:俺|私|僕)の名前は[「『]?([^、。！!？?\s]+?)[」』]?(?:って|と)?覚え/,
    /名前は[「『]?([^、。！!？?\s]+?)[」』]?(?:って|と)?覚え/,
    /名前(?:が|は)[「『]?([^、。！!？?\s]+?)[」』]?(?:です|だよ|だ|って)/
  ];

  for (
    const pattern of namePatterns
  ) {
    const match =
      text.match(pattern);

    if (
      match?.[1]
    ) {
      const value =
        cleanMemoryValue(
          match[1]
        );

      results.push({
        type:
          "profile",

        key:
          "name",

        value,

        text:
          `名前は${value}`,

        savedAt:
          now
      });

      break;
    }
  }


  // ==========================================
  // 呼び方
  // ==========================================

  const nicknamePatterns = [
    /呼び方は[「『]?([^、。！!？?\s]+?)[」』]?(?:でいい|でよい|にして|って)/,
    /[「『]?([^、。！!？?\s]+?)[」』]?(?:って|と)呼んで/,
    /呼ぶ時は[「『]?([^、。！!？?\s]+?)[」』]?/
  ];

  for (
    const pattern of nicknamePatterns
  ) {
    const match =
      text.match(pattern);

    if (
      match?.[1]
    ) {
      const value =
        cleanMemoryValue(
          match[1]
        );

      results.push({
        type:
          "profile",

        key:
          "nickname",

        value,

        text:
          `呼び方は${value}`,

        savedAt:
          now
      });

      break;
    }
  }


  // ==========================================
  // 好きな食べ物
  // ==========================================

  const foodPatterns = [
    /好きな食べ物は[「『]?([^、。！!？?\n]+?)[」』]?(?:って|と)?覚え/,
    /好きな食べ物(?:が|は)[「『]?([^、。！!？?\n]+?)[」』]?(?:です|だよ|だ)(?:って)?/,
    /[「『]?([^、。！!？?\s]+?)[」』]?(?:が|は)好き(?:って)?覚え/
  ];

  for (
    const pattern of foodPatterns
  ) {
    const match =
      text.match(pattern);

    if (
      match?.[1]
    ) {
      const value =
        cleanMemoryValue(
          match[1]
        );

      results.push({
        type:
          "preference",

        key:
          "favorite_food",

        value,

        text:
          `好きな食べ物は${value}`,

        savedAt:
          now
      });

      break;
    }
  }

  return dedupeMemories(
    results
  );
}


// ==============================================
// 保存直後の正確な返信
// ==============================================

function buildSavedProfileReply(
  memories
) {
  if (
    !Array.isArray(memories) ||
    memories.length === 0
  ) {
    return "";
  }

  const name =
    memories.find(
      item =>
        item.key === "name"
    )?.value;

  const nickname =
    memories.find(
      item =>
        item.key === "nickname"
    )?.value;

  const food =
    memories.find(
      item =>
        item.key === "favorite_food"
    )?.value;


  if (
    name &&
    nickname
  ) {
    return (
      `覚えたよ〜😊 名前は「${name}」、` +
      `呼ぶ時は「${nickname}」ね！` +
      `ちゃんと覚えとくばい👌`
    );
  }


  if (name) {
    return (
      `覚えたよ〜😊 名前は「${name}」ね！` +
      `ちゃんと覚えとくばい👌`
    );
  }


  if (nickname) {
    return (
      `了解👌 これから「${nickname}」って呼ぶね！`
    );
  }


  if (food) {
    return (
      `覚えたよ〜😊 好きな食べ物は「${food}」ね！`
    );
  }


  return "";
}


// ==============================================
// 名前・呼び方の質問
// ==============================================

function buildExactProfileReply(
  message,
  memories
) {
  const asksName =
    message.includes("名前");

  const asksNickname =
    message.includes("呼び") ||
    message.includes("なんて呼") ||
    message.includes("何て呼");


  if (
    !asksName &&
    !asksNickname
  ) {
    return "";
  }


  const name =
    getExactMemoryValue(
      memories,
      "name"
    );

  const nickname =
    getExactMemoryValue(
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
        `ちゃぴは「${nickname}」って呼ぶよ😊 ` +
        `ちゃんと覚えとるばい！`
      );
    }

    if (name) {
      return (
        `名前は「${name}」って覚えとるよ😊 ` +
        `呼び方はまだ覚えとらんみたい。`
      );
    }

    return (
      "ごめん、名前と呼び方はまだちゃんと記憶できとらんみたい💦"
    );
  }


  if (asksName) {
    if (name) {
      return (
        `名前は「${name}」ばい😊 ` +
        `ちゃんと覚えとるよ！`
      );
    }

    return (
      "名前はまだ記憶できとらんみたい💦"
    );
  }


  if (asksNickname) {
    if (nickname) {
      return (
        `「${nickname}」って呼ぶよ😊 ` +
        `ちゃんと覚えとるばい！`
      );
    }

    return (
      "呼び方はまだ記憶できとらんみたい💦"
    );
  }


  return "";
}


// ==============================================
// 好きな食べ物の質問
// ==============================================

function buildExactFoodReply(
  message,
  memories
) {
  const asksFood =
    message.includes("好きな食べ物") ||
    (
      message.includes("食べ物") &&
      message.includes("好き")
    );


  if (!asksFood) {
    return "";
  }


  const food =
    getExactMemoryValue(
      memories,
      "favorite_food"
    );


  if (food) {
    return (
      `好きな食べ物は「${food}」ばい😊 ` +
      `ちゃんと覚えとるよ！`
    );
  }


  return (
    "好きな食べ物はまだ記憶できとらんみたい💦"
  );
}


// ==============================================
// 正確な記憶値取得
// ==============================================

function getExactMemoryValue(
  memories,
  key
) {
  const exact =
    memories
      .filter(
        item =>
          item?.key === key &&
          item?.value
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


  return exact
    ? String(
        exact.value
      )
    : "";
}


// ==============================================
// 重複排除
// ==============================================

function dedupeMemories(items) {
  const map =
    new Map();

  for (
    const item of items
  ) {
    if (
      !item?.key
    ) {
      continue;
    }

    map.set(
      item.key,
      item
    );
  }

  return [
    ...map.values()
  ];
}


// ==============================================
// 同種類の記憶を更新
// ==============================================

function upsertMemory(
  memories,
  newMemory
) {
  const normalized =
    memories.map(
      normalizeMemoryObject
    );

  const index =
    normalized.findIndex(
      item =>
        item.key === newMemory.key
    );


  if (
    index >= 0
  ) {
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
// 記憶オブジェクト正規化
// ==============================================

function normalizeMemoryObject(item) {
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

  return {
    type:
      "general",

    key:
      normalizeMemoryKey(
        text
      ),

    value:
      text,

    text,

    savedAt:
      item?.savedAt || ""
  };
}


// ==============================================
// 関係ある記憶だけ選択
// ==============================================

function selectRelevantMemories(
  message,
  memories
) {
  const text =
    message.toLowerCase();


  if (
    text.includes("名前") ||
    text.includes("呼び方") ||
    text.includes("呼んで")
  ) {
    return memories
      .filter(
        item =>
          item.key === "name" ||
          item.key === "nickname"
      )
      .slice(-4);
  }


  if (
    text.includes("食べ物") ||
    text.includes("料理") ||
    text.includes("カレー")
  ) {
    return memories
      .filter(
        item =>
          item.key === "favorite_food"
      )
      .slice(-3);
  }


  return [];
}


// ==============================================
// 記憶表示
// ==============================================

function memoryToText(item) {
  if (
    item?.key === "name"
  ) {
    return (
      `名前: ${item.value}`
    );
  }


  if (
    item?.key === "nickname"
  ) {
    return (
      `呼び方: ${item.value}`
    );
  }


  if (
    item?.key === "favorite_food"
  ) {
    return (
      `好きな食べ物: ${item.value}`
    );
  }


  return (
    item?.text ||
    String(item || "")
  );
}


// ==============================================
// 記憶値クリーニング
// ==============================================

function cleanMemoryValue(value) {
  return String(
    value || ""
  )
    .replace(
      /って$/g,
      ""
    )
    .replace(
      /と$/g,
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
      /でいい.*$/g,
      ""
    )
    .replace(
      /です$/g,
      ""
    )
    .trim();
}


// ==============================================
// 一般記憶キー
// ==============================================

function normalizeMemoryKey(text) {
  return (
    "general_" +
    simpleHash(
      String(
        text || ""
      )
    )
  );
}


// ==============================================
// 検索要否判定
// ==============================================

function decideWhetherToSearch(message) {
  const text =
    message.trim();


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
        text.includes(
          word
        )
    )
  ) {
    return {
      search:
        false,

      query:
        "",

      freshness:
        "none"
    };
  }


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
      search:
        false,

      query:
        "",

      freshness:
        "none"
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
        text.includes(
          word
        )
    );


  if (
    !shouldSearch
  ) {
    return {
      search:
        false,

      query:
        "",

      freshness:
        "none"
    };
  }


  let freshness =
    "none";


  if (
    text.includes(
      "今日の"
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
    search:
      true,

    query:
      cleanSearchQuery(
        text
      ),

    freshness
  };
}


// ==============================================
// 検索語整理
// ==============================================

function cleanSearchQuery(text) {
  return String(
    text
  )
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


// ==============================================
// Tavily検索
// ==============================================

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
    `tavily:v8:${simpleHash(
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
      getDomain(
        item.url
      );

    const current =
      domainCounts.get(
        domain
      ) || 0;


    if (
      current >= 2
    ) {
      continue;
    }


    selected.push(
      item
    );


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
      JSON.stringify(
        result
      ),
      {
        expirationTtl:
          900
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


  if (
    !response.ok
  ) {
    throw new Error(
      `Tavily ${response.status}: ${text.slice(0, 500)}`
    );
  }


  let data;


  try {
    data =
      JSON.parse(
        text
      );
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

function mergeResults(
  a,
  b
) {
  const map =
    new Map();


  for (
    const item of [
      ...a,
      ...b
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
    ...map.values()
  ];
}


// ==============================================
// 危険サイト除外
// ==============================================

function isSafeSearchResult(
  item
) {
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
        url.includes(
          domain
        )
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
        text.includes(
          word
        )
    )
  ) {
    return false;
  }


  return true;
}


// ==============================================
// 公式優先
// ==============================================

function trustedBoost(url) {
  const domain =
    getDomain(
      url
    );


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
      domain.includes(
        item
      )
  )
    ? 1
    : 0;
}


// ==============================================
// 検索関連度
// ==============================================

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
    return 0;
  }


  const normalizedTarget =
    String(
      target
    ).toLowerCase();


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
// 検索キーワード
// ==============================================

function extractKeywords(text) {
  return String(
    text
  )
    .replace(
      /[？?！!。、,.]/g,
      " "
    )
    .replace(
      /(最新情報|最新|最近|調べて|検索して|教えて|について|とは|ニュース|現在|今日)/g,
      " "
    )
    .split(
      /\s+/
    )
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
    return new URL(
      url
    )
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
    String(
      text || ""
    );


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
        /なんや/g,
        "なん"
      );


  return (
    cleaned.trim()
  );
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
  ).toString(
    16
  );
}


// ==============================================
// AI返答取り出し
// ==============================================

function extractAIText(
  aiResponse
) {
  if (
    !aiResponse
  ) {
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
    return (
      choiceContent.trim()
    );
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
