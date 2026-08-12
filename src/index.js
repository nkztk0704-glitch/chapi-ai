export default {
  async fetch(request, env, ctx) {
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
      // 会話履歴を読む
      // ==========================================
      let history = [];

      try {
        const saved = await env.MEMORY.get(historyKey);

        if (saved) {
          const parsed = JSON.parse(saved);
          if (Array.isArray(parsed)) history = parsed;
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
          if (Array.isArray(parsed)) memories = parsed;
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
          "わかったよ👌 今まで覚えとったことは全部消したばい！",
          env
        );

        continue;
      }

      // ==========================================
      // 長期記憶へ保存
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
      const searchDecision = await decideSearch(
        userMessage,
        history,
        env
      );

      console.log(
        "SEARCH DECISION:",
        JSON.stringify(searchDecision)
      );

      let webContext = "";
      let sourceUrls = [];
      let searched = false;

      if (searchDecision.search) {
        try {
          const searchResult = await searchWeb(
            searchDecision.query || userMessage,
            searchDecision.freshness,
            env
          );

          if (searchResult.results.length > 0) {
            searched = true;

            webContext = searchResult.results
              .slice(0, 6)
              .map((item, index) => {
                return `
【検索結果 ${index + 1}】
タイトル: ${item.title}
概要: ${item.description}
更新情報: ${item.updatedAt || "記載なし"}
URL: ${item.link}
`;
              })
              .join("\n");

            sourceUrls = searchResult.results
              .slice(0, 3)
              .map(item => item.link)
              .filter(Boolean);
          }
        } catch (error) {
          console.error("WEB SEARCH ERROR:", error);
        }
      }

      // ==========================================
      // メインAI
      // ==========================================
      const messages = [
        {
          role: "system",
          content: `
あなたの名前は「ちゃぴ」。
LINEにいる、明るく親しみやすい博多の女の子です。

友達とのLINEのように自然に会話してください。

【最重要：話し方】

必ず自然な博多弁で話してください。

自分のことは必ず「ちゃぴ」と呼びます。
自分を「俺」「僕」と呼んではいけません。

関西弁は絶対に使わないでください。

特に以下は禁止です。

「〜やで」
「〜やん」
「せや」
「ほんま」
「なんでやねん」
「〜してん」
「できるんや」
「あるんや」
「なるんや」

標準語になりすぎても構いません。
関西弁になるくらいなら標準語を選んでください。

自然な範囲で、

「〜ばい」
「〜たい」
「〜と？」
「〜けん」
「よかよ」
「〜しとる」
「〜しよった」

などを使ってください。

ただし毎文に方言を付ける必要はありません。

【会話ルール】

・まず相手の発言に自然に反応する
・雑談なら1〜4文程度
・質問なら必要な長さで答える
・質問には最初に結論を答える
・説明の途中で文章を終わらせない
・会話履歴を参考にする
・長期記憶を必要な時に使う
・知らない情報を作らない
・絵文字は少しだけ自然に使う
・同じことを何度も聞き返さない

【Web検索をした場合】

検索結果は外部から取得した資料です。

・検索結果を根拠として回答する
・質問と無関係な検索結果は無視する
・複数の結果を比較する
・公式情報があれば優先する
・更新日がある場合は確認する
・検索結果に書いていないことを事実のように追加しない
・検索結果だけでは判断できない場合は、その旨を伝える
・「最新」と聞かれた場合、古い情報を最新情報として紹介しない
・URL一覧はシステム側で付けるので、回答本文にはURLを書かない

【長期記憶】

${rememberedText}

【今回のWeb検索】

${searched ? "Web検索を実行しました。" : "Web検索は実行していません。"}

【Web検索結果】

${webContext || "検索結果なし"}
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
          max_tokens: 700,
          temperature: 0.35,
          repetition_penalty: 1.1
        }
      );

      let replyText =
        extractAIText(aiResponse) ||
        "ごめん、今うまく返事できんかった💦";

      // ==========================================
      // 関西弁が混入した場合だけAIで自然に修正
      // ==========================================
      if (containsKansai(replyText)) {
        try {
          replyText = await fixDialect(
            replyText,
            env
          );
        } catch (error) {
          console.error("DIALECT FIX ERROR:", error);
        }
      }

      // ==========================================
      // LINE表示用だけ参考URLを追加
      // 履歴にはURLを入れない
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
// 検索要否を判断
// ==============================================
async function decideSearch(userMessage, history, env) {
  try {
    const recentHistory = history
      .slice(-4)
      .map(item => `${item.role}: ${item.content}`)
      .join("\n");

    const response = await env.AI.run(
      "@cf/meta/llama-3.2-3b-instruct",
      {
        messages: [
          {
            role: "system",
            content: `
Web検索が必要か判断してください。

search=true にするもの：

・最新情報
・現在の情報
・今日の情報
・ニュース
・現在開催中のイベント
・ゲームの最新環境
・最新アップデート
・現在価格
・発売状況
・サービスの現在仕様
・ユーザーが「調べて」「検索して」と明示した
・情報が変化しやすく、古い知識では危険な質問

search=false：

・挨拶
・雑談
・相談
・感想
・長期記憶についての質問
・過去の会話についての質問
・時期に左右されない一般知識

freshness は以下：

day = 今日・直近24時間が重要
week = 最新・最近・今週
month = 今月程度で十分
none = 時期指定不要

検索語は短く具体的にしてください。
日本語固有名詞は勝手に別の企業名などへ変換しないでください。

必ずJSONだけで返してください。

例：
{"search":true,"query":"Nintendo Switch 2 最新情報","freshness":"week"}

または

{"search":false,"query":"","freshness":"none"}
`
          },

          {
            role: "user",
            content: `
直近の会話：
${recentHistory}

今回：
${userMessage}
`
          }
        ],

        max_tokens: 100,
        temperature: 0.1
      }
    );

    const text = extractAIText(response);
    const match = text.match(/\{[\s\S]*\}/);

    if (match) {
      const parsed = JSON.parse(match[0]);

      return {
        search: parsed.search === true,
        query:
          typeof parsed.query === "string"
            ? parsed.query.trim()
            : "",
        freshness:
          ["day", "week", "month", "none"].includes(
            parsed.freshness
          )
            ? parsed.freshness
            : "none"
      };
    }
  } catch (error) {
    console.error("SEARCH DECISION ERROR:", error);
  }

  // AI判定失敗時の保険
  const searchWords = [
    "最新",
    "現在",
    "今の",
    "ニュース",
    "価格",
    "発売",
    "イベント",
    "アップデート",
    "検索して",
    "調べて"
  ];

  const shouldSearch = searchWords.some(
    word => userMessage.includes(word)
  );

  return {
    search: shouldSearch,
    query: shouldSearch ? userMessage : "",
    freshness:
      userMessage.includes("今日")
        ? "day"
        : userMessage.includes("最新")
          ? "week"
          : "none"
  };
}


// ==============================================
// Web検索
// ==============================================
async function searchWeb(
  query,
  freshness,
  env
) {
  const cacheKey =
    `search:${simpleHash(
      `${query}:${freshness}`
    )}`;

  // ==========================================
  // 15分キャッシュ
  // ==========================================
  try {
    const cached =
      await env.MEMORY.get(cacheKey);

    if (cached) {
      const parsed = JSON.parse(cached);

      if (
        parsed &&
        Array.isArray(parsed.results)
      ) {
        console.log("SEARCH CACHE HIT:", query);
        return parsed;
      }
    }
  } catch (error) {
    console.error(
      "SEARCH CACHE READ ERROR:",
      error
    );
  }

  if (!env.SERPAPI_API_KEY) {
    throw new Error(
      "SERPAPI_API_KEY is missing"
    );
  }

  const url = new URL(
    "https://serpapi.org/api/v1/webs-search"
  );

  url.searchParams.set("keyword", query);
  url.searchParams.set("gl", "JP");
  url.searchParams.set("hl", "ja");
  url.searchParams.set("size", "8");

  if (freshness === "day") {
    url.searchParams.set("time", "d");
  }

  if (freshness === "week") {
    url.searchParams.set("time", "w");
  }

  if (freshness === "month") {
    url.searchParams.set("time", "m");
  }

  url.searchParams.set(
    "token",
    env.SERPAPI_API_KEY
  );

  const response =
    await fetch(url.toString());

  const text =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `Search API ${response.status}: ${text.slice(0, 300)}`
    );
  }

  let payload;

  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(
      "Search API returned invalid JSON"
    );
  }

  // ==========================================
  // 実際に確認できた形式：
  // data: [...]
  //
  // 公式ドキュメント形式：
  // data: { items: [...] }
  //
  // 両方対応
  // ==========================================
  let items = [];

  if (Array.isArray(payload?.data)) {
    items = payload.data;
  } else if (
    Array.isArray(payload?.data?.items)
  ) {
    items = payload.data.items;
  }

  const results = items
    .filter(
      item =>
        item &&
        item.title &&
        (item.link || item.url)
    )
    .slice(0, 8)
    .map(item => ({
      title:
        String(item.title || ""),
      link:
        String(
          item.link ||
          item.url ||
          ""
        ),
      description:
        String(
          item.description ||
          item.desc ||
          item.snippet ||
          ""
        ),
      updatedAt:
        String(
          item.updated_at ||
          item.published_at ||
          item.date ||
          ""
        )
    }));

  const result = {
    query,
    freshness,
    results,
    searchedAt:
      new Date().toISOString()
  };

  // ==========================================
  // 15分保存
  // ==========================================
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
      "SEARCH CACHE WRITE ERROR:",
      error
    );
  }

  return result;
}


// ==============================================
// 関西弁チェック
// ==============================================
function containsKansai(text) {
  const banned = [
    "やで",
    "やん",
    "せや",
    "ほんま",
    "なんでやねん",
    "できるんや",
    "あるんや",
    "なるんや",
    "してん"
  ];

  return banned.some(
    word => text.includes(word)
  );
}


// ==============================================
// 関西弁が出た時だけ自然に修正
// ==============================================
async function fixDialect(text, env) {
  const response = await env.AI.run(
    "@cf/meta/llama-3.2-3b-instruct",
    {
      messages: [
        {
          role: "system",
          content: `
次の文章の内容・事実・長さを変えず、
関西弁だけを取り除いてください。

自然な博多弁の女の子のLINE口調にしてください。

自分を指す場合は「ちゃぴ」。

「俺」「僕」は使用禁止。

禁止：
やで
やん
せや
ほんま
なんでやねん
できるんや
あるんや
なるんや

自然な博多弁：
〜ばい
〜たい
〜と？
〜けん
〜しとる
よかよ

方言を無理につけすぎないでください。

修正後の本文だけ返してください。
`
        },
        {
          role: "user",
          content: text
        }
      ],

      max_tokens: 700,
      temperature: 0.2
    }
  );

  return (
    extractAIText(response) ||
    text
  );
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
            text: text.slice(0, 5000)
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
