// Inspect the live page state: which renderer(s) are actually in play?
const out = await page.evaluate(() => {
  const badges = [...document.querySelectorAll('.larp-badge')].map((b) => {
    const card = b.closest('[componentkey^="update-card-focus"]');
    const textEl = card?.querySelector('[data-testid="expandable-text-box"]');
    const cardRect = card?.getBoundingClientRect();
    const textRect = textEl?.getBoundingClientRect();
    const badgeRect = b.getBoundingClientRect();
    return {
      cls: b.className,
      kind: b.dataset.kind,
      anchor: b.dataset.anchor || null,
      hasEmojiSpan: Boolean(b.querySelector('.larp-badge__emoji')),
      hasDot: Boolean(b.querySelector('.larp-badge__dot')),
      offsetFromCardTop: cardRect ? Math.round(badgeRect.top - cardRect.top) : null,
      textBottomFromCardTop: cardRect && textRect ? Math.round(textRect.bottom - cardRect.top) : null,
      textLeftFromCardLeft: cardRect && textRect ? Math.round(textRect.left - cardRect.left) : null,
      badgeLeftFromCardLeft: cardRect ? Math.round(badgeRect.left - cardRect.left) : null,
      html: b.innerHTML.slice(0, 90),
    };
  });
  return {
    url: location.href,
    badgeCount: badges.length,
    badges,
    visibleMsOverride: window.__larpBadgeVisibleMs ?? null,
    debug: window.__larpDebug ?? null,
    emojiSpanCount: document.querySelectorAll('.larp-badge__emoji').length,
  };
});
return out;
