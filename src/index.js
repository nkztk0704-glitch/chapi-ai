.sort((a, b) => {
  const aFresh = freshnessScore(a);
  const bFresh = freshnessScore(b);

  const aTotal =
    a.trust * 3 +
    a.relevance * 2 +
    a.score +
    aFresh * 3;

  const bTotal =
    b.trust * 3 +
    b.relevance * 2 +
    b.score +
    bFresh * 3;

  return bTotal - aTotal;
})
