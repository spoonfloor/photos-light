import { expect, test } from '@playwright/test';

const PIXEL =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const MOCK_SHARE = {
  album: {
    id: '11111111-1111-1111-1111-111111111111',
    title: 'E2E Test Album',
    photo_count: 2,
    created_at: '2026-02-26T12:00:00Z',
  },
  photos: [
    {
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      position: 0,
      date_taken: '2026-02-26T14:30:00Z',
      file_type: 'photo',
      width: 100,
      height: 100,
      rating: null,
      original_filename: 'first.jpg',
      thumb_url: PIXEL,
      original_url: PIXEL,
      display_url: PIXEL,
    },
    {
      id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      position: 1,
      date_taken: '2026-02-26T15:00:00Z',
      file_type: 'photo',
      width: 100,
      height: 100,
      rating: 5,
      original_filename: 'second.jpg',
      thumb_url: PIXEL,
      original_url: PIXEL,
      display_url: PIXEL,
    },
  ],
};

const MOCK_SHARE_META = {
  album: MOCK_SHARE.album,
  first_cluster: {
    month_key: '2026-02',
    day_key: '2026-02-26',
    date_taken: '2026-02-26T14:30:00Z',
  },
  sort: 'oldest',
};

async function mockShareResolve(page, payload = MOCK_SHARE) {
  await page.route('**/functions/v1/share-resolve**', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('phase') === 'meta') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_SHARE_META),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });
  });
}

test.describe('share viewer parity', () => {
  test('missing token shows error', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#shareError')).toHaveText('Missing share link.');
  });

  test('loads album grid from share-resolve', async ({ page }) => {
    await mockShareResolve(page);
    await page.goto('/?t=e2e-test-token');
    await expect(page.locator('#sharePageTitle')).toHaveText('E2E Test Album');
    await expect(page.locator('.photo-card')).toHaveCount(2);
    await expect(page.locator('.month-select-circle')).toHaveCount(1);
    await expect(page.locator('.month-label')).toHaveCount(1);
  });

  test('single-month share hides date jumper', async ({ page }) => {
    await mockShareResolve(page);
    await page.goto('/?t=e2e-test-token');
    await expect(page.locator('#surfaceLoadOverlay')).toBeHidden();
    await expect(page.locator('.date-picker')).toBeHidden();
  });

  test('single-year multi-month share shows static year without dropdown chevron', async ({
    page,
  }) => {
    const payload = structuredClone(MOCK_SHARE);
    payload.photos[1].date_taken = '2026-03-15T12:00:00Z';
    await mockShareResolve(page, payload);
    await page.goto('/?t=e2e-test-token');
    await expect(page.locator('#surfaceLoadOverlay')).toBeHidden();
    await expect(page.locator('.date-picker')).toBeVisible();
    await expect(page.locator('#yearPicker')).toHaveValue('2026');
    await expect(page.locator('#yearPicker')).toHaveClass(/date-picker-select--static/);
    const chevron = await page.locator('#yearPicker').evaluate(
      (el) => getComputedStyle(el).backgroundImage,
    );
    expect(chevron).toBe('none');
  });

  test('multi-year share keeps interactive year dropdown', async ({ page }) => {
    const payload = structuredClone(MOCK_SHARE);
    payload.photos[1].date_taken = '2025-12-01T12:00:00Z';
    await mockShareResolve(page, payload);
    await page.goto('/?t=e2e-test-token');
    await expect(page.locator('#surfaceLoadOverlay')).toBeHidden();
    await expect(page.locator('.date-picker')).toBeVisible();
    await expect(page.locator('#yearPicker option')).toHaveCount(2);
    await expect(page.locator('#yearPicker')).not.toHaveClass(/date-picker-select--static/);
  });

  test('html-first load shell before scripts run', async ({ page }) => {
    await page.route('**/*.js', (route) => route.abort());
    await mockShareResolve(page);
    await page.goto('/?t=e2e-test-token', { waitUntil: 'load' });

    await expect(page.locator('body')).toHaveClass(/surface-load-active/);
    await expect(page.locator('#surfaceLoadOverlay')).toBeVisible();
    await expect(page.locator('[data-filter="recentImports"]')).toHaveCount(0);
    // App-only app-bar actions ship `hidden` in the shared appBar.html
    // fragment so they never flash before shareBoot's chrome pass runs.
    await expect(page.locator('#addPhotoBtn')).toBeHidden();
    await expect(page.locator('#editDateBtn')).toBeHidden();
    await expect(page.locator('#deleteBtn')).toBeHidden();

    const sortPointerEvents = await page.locator('#sortToggleBtn').evaluate(
      (el) => getComputedStyle(el).pointerEvents,
    );
    expect(sortPointerEvents).toBe('none');
  });

  test('loading card appears after scrim delay', async ({ page }) => {
    await page.route('**/functions/v1/share-resolve**', async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('phase') === 'meta') {
        await new Promise((resolve) => setTimeout(resolve, 800));
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(MOCK_SHARE_META),
        });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_SHARE),
      });
    });

    await page.goto('/?t=e2e-test-token');
    await expect(page.locator('#surfaceLoadOverlay .import-card')).toBeVisible({
      timeout: 1000,
    });
    await expect(page.locator('#surfaceLoadTitle')).toHaveText('Loading share page');
    await expect(page.locator('#surfaceLoadStatusLabel')).toHaveText(
      'Retrieving shared photos and videos.',
    );
  });

  test('paints instant skeleton before meta resolves', async ({ page }) => {
    let metaReleased = false;
    await page.route('**/functions/v1/share-resolve**', async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('phase') === 'meta') {
        await new Promise((resolve) => setTimeout(resolve, 400));
        metaReleased = true;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(MOCK_SHARE_META),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_SHARE),
      });
    });

    await page.goto('/?t=e2e-test-token');
    await expect(page.locator('.surface-skeleton-card')).not.toHaveCount(0);
    await expect(page.locator('#sharePageTitle')).toHaveClass(/surface-layout-placeholder/);
    await expect(page.locator('.month-label')).toHaveClass(/surface-layout-placeholder/);
    expect(metaReleased).toBe(false);

    await expect(page.locator('#sharePageTitle')).not.toHaveClass(/surface-layout-placeholder/, {
      timeout: 5000,
    });
    await expect(page.locator('.month-label')).toHaveText('February 26, 2026');
    await expect(page.locator('.photo-card[data-id]')).toHaveCount(2, {
      timeout: 5000,
    });
  });

  test('star toggle updates card without full rebuild', async ({ page }) => {
    await mockShareResolve(page);
    await page.goto('/?t=e2e-test-token');
    await expect(page.locator('#surfaceLoadOverlay')).toBeHidden();
    const unstarredCard = page.locator('.photo-card[data-id="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"]');
    await expect(unstarredCard).not.toHaveClass(/is-starred/);
    await unstarredCard.locator('.star-badge').click({ force: true });
    await expect(unstarredCard).toHaveClass(/is-starred/);
    await expect(page.locator('.photo-card')).toHaveCount(2);
  });

  test('unstar last filtered photo rebuilds grid after starred filter clears', async ({
    page,
  }) => {
    await mockShareResolve(page);
    await page.goto('/?t=e2e-test-token');
    await expect(page.locator('#surfaceLoadOverlay')).toBeHidden();

    const publishedStarCard = page.locator(
      '.photo-card[data-id="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"]',
    );
    await expect(publishedStarCard).toHaveClass(/is-starred/);
    await publishedStarCard.locator('.star-badge').click({ force: true });
    await expect(publishedStarCard).not.toHaveClass(/is-starred/);

    const starredCard = page.locator('.photo-card[data-id="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"]');
    await starredCard.locator('.star-badge').click({ force: true });
    await page.locator('.filter-chip[data-filter="starred"]').click();
    await expect(page.locator('.photo-card')).toHaveCount(1);

    await starredCard.click();
    await expect(page.locator('#lightboxOverlay')).toBeVisible();
    await page.locator('#lightboxStarBtn').click();
    await page.locator('#lightboxBackBtn').click();
    await expect(page.locator('#lightboxOverlay')).toBeHidden();

    await expect(page.locator('.photo-card')).toHaveCount(2);
    await expect(page.locator('#shareEmpty')).toBeHidden();
    await expect(page.locator('.filter-chip[data-filter="starred"]')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  test('selection circle toggles selected state', async ({ page }) => {
    await mockShareResolve(page);
    await page.goto('/?t=e2e-test-token');
    const firstCard = page.locator('.photo-card[data-id="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"]');
    await firstCard.locator('.select-circle').click();
    await expect(firstCard).toHaveClass(/\bselected\b/);
    await expect(page.locator('#deselectAllBtn')).not.toHaveClass(/inactive/);
  });

  test('app-bar download button is enabled on load and stays enabled', async ({ page }) => {
    await mockShareResolve(page);
    await page.goto('/?t=e2e-test-token');
    await expect(page.locator('#surfaceLoadOverlay')).toBeHidden();

    // Enabled with no selection (download = whole album).
    await expect(page.locator('#downloadBtn')).toBeVisible();
    await expect(page.locator('#downloadBtn')).not.toHaveClass(/\binactive\b/);

    // Still enabled with a selection (download = selection).
    await page
      .locator('.photo-card[data-id="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"] .select-circle')
      .click();
    await expect(page.locator('#downloadBtn')).not.toHaveClass(/\binactive\b/);

    // And after clearing the selection.
    await page.locator('#deselectAllBtn').click();
    await expect(page.locator('#downloadBtn')).not.toHaveClass(/\binactive\b/);
  });

  test('utilities menu shows copy link without manage links', async ({ page }) => {
    await mockShareResolve(page);
    await page.goto('/?t=e2e-test-token');
    await expect(page.locator('#surfaceLoadOverlay')).toBeHidden();
    await page.locator('#utilitiesBtn').click();
    await expect(page.locator('#copyShareLinkBtn')).toBeVisible();
    await expect(page.locator('#copyShareLinkBtn')).toHaveText(/Copy link/);
    // Present in the shared utilitiesMenu.html fragment but data-cap
    // gated off for share (shareLink: false) — chrome.js hides them.
    await expect(page.locator('#manageShareLinksBtn')).toBeHidden();
    await expect(page.locator('#getShareLinkBtn')).toBeHidden();
  });

  test('clear-selection button exits select mode with nothing selected (#7)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 400, height: 800 });
    await mockShareResolve(page);
    await page.goto('/?t=e2e-test-token');
    await expect(page.locator('#surfaceLoadOverlay')).toBeHidden();

    // Enter select mode via the utilities CTA (long-press equivalent).
    await page.locator('#utilitiesBtn').click();
    await page.locator('#selectModeBtn').click();
    await expect(page.locator('#photoContainer')).toHaveClass(/\bselect-mode\b/);

    // Nothing selected, but the clear-selection button must stay tappable.
    await expect(page.locator('#deselectAllBtn')).not.toHaveClass(/\binactive\b/);

    // Tapping it exits select mode and re-inactivates the button.
    await page.locator('#deselectAllBtn').click();
    await expect(page.locator('#photoContainer')).not.toHaveClass(/\bselect-mode\b/);
    await expect(page.locator('#deselectAllBtn')).toHaveClass(/\binactive\b/);
  });

  test('tapping share header dead space exits select mode (#6)', async ({ page }) => {
    await page.setViewportSize({ width: 400, height: 800 });
    await mockShareResolve(page);
    await page.goto('/?t=e2e-test-token');
    await expect(page.locator('#surfaceLoadOverlay')).toBeHidden();

    await page.locator('#utilitiesBtn').click();
    await page.locator('#selectModeBtn').click();
    await expect(page.locator('#photoContainer')).toHaveClass(/\bselect-mode\b/);

    // Tap the album-title row (non-interactive header chrome) — dismisses.
    await page.locator('#sharePageTitle').click();
    await expect(page.locator('#photoContainer')).not.toHaveClass(/\bselect-mode\b/);

    // Re-enter, then confirm a filter chip still toggles (not swallowed).
    await page.locator('#utilitiesBtn').click();
    await page.locator('#selectModeBtn').click();
    await expect(page.locator('#photoContainer')).toHaveClass(/\bselect-mode\b/);
    await page.locator('.filter-chip[data-filter="starred"]').click();
    await expect(page.locator('.filter-chip[data-filter="starred"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('copy link writes share url and shows toast', async ({ page }) => {
    await mockShareResolve(page);
    await page.goto('/?t=e2e-test-token');
    await expect(page.locator('#surfaceLoadOverlay')).toBeHidden();
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.locator('#utilitiesBtn').click();
    await page.locator('#copyShareLinkBtn').click();
    await expect(page.locator('#toast')).toBeVisible();
    await expect(page.locator('#toastMessage')).toHaveText('Link copied to clipboard');
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toContain('t=e2e-test-token');
  });

  test('lightbox loads photo from grid click', async ({ page }) => {
    await mockShareResolve(page);
    await page.goto('/?t=e2e-test-token');
    await expect(page.locator('#surfaceLoadOverlay')).toBeHidden();
    await page.locator('.photo-card[data-id="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"]').click();
    await expect(page.locator('#lightboxOverlay')).toBeVisible();
    await expect(page.locator('#lightboxContent .lightbox-media-element')).toBeVisible({
      timeout: 5000,
    });
  });

  test('lightbox info panel scales photo into remaining space', async ({ page }) => {
    const payload = structuredClone(MOCK_SHARE);
    payload.photos[0] = { ...payload.photos[0], width: 800, height: 2000 };
    await mockShareResolve(page, payload);
    await page.goto('/?t=e2e-test-token');
    await expect(page.locator('#surfaceLoadOverlay')).toBeHidden();
    await page.locator('.photo-card[data-id="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"]').click();
    await expect(page.locator('#lightboxContent .lightbox-media-frame')).toBeVisible({
      timeout: 5000,
    });

    const before = await page.locator('#lightboxContent .lightbox-media-frame').evaluate((frame) => {
      const content = document.getElementById('lightboxContent');
      const frameBox = frame.getBoundingClientRect();
      const contentBox = content.getBoundingClientRect();
      return {
        frameHeight: frameBox.height,
        contentHeight: contentBox.height,
        frameTop: frameBox.top,
        contentTop: contentBox.top,
      };
    });

    await page.locator('#lightboxInfoBtn').click();
    await expect(page.locator('#lightboxInfoPanel')).toBeVisible();

    const after = await page.locator('#lightboxContent .lightbox-media-frame').evaluate((frame) => {
      const content = document.getElementById('lightboxContent');
      const frameBox = frame.getBoundingClientRect();
      const contentBox = content.getBoundingClientRect();
      return {
        frameHeight: frameBox.height,
        frameWidth: frameBox.width,
        contentHeight: contentBox.height,
        contentWidth: contentBox.width,
        frameTop: frameBox.top,
        frameBottom: frameBox.bottom,
        contentTop: contentBox.top,
        contentBottom: contentBox.bottom,
      };
    });

    expect(after.contentHeight).toBeLessThan(before.contentHeight);
    expect(after.frameHeight).toBeLessThan(before.frameHeight);
    expect(after.frameTop).toBeGreaterThanOrEqual(after.contentTop - 1);
    expect(after.frameBottom).toBeLessThanOrEqual(after.contentBottom + 1);
    expect(after.frameWidth).toBeLessThanOrEqual(after.contentWidth + 1);
  });

  test('lightbox uses original_url when display_url omitted for browser-native still', async ({
    page,
  }) => {
    const payload = structuredClone(MOCK_SHARE);
    for (const photo of payload.photos) {
      delete photo.display_url;
    }
    await mockShareResolve(page, payload);
    await page.goto('/?t=e2e-test-token');
    await expect(page.locator('#surfaceLoadOverlay')).toBeHidden();
    await page.locator('.photo-card[data-id="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"]').click();
    await expect(page.locator('#lightboxOverlay')).toBeVisible();
    await expect(page.locator('#lightboxContent .lightbox-media-element')).toBeVisible({
      timeout: 5000,
    });
  });

  test('lightbox stays closed when display tier unavailable', async ({ page }) => {
    const payload = structuredClone(MOCK_SHARE);
    payload.photos = [
      {
        ...payload.photos[0],
        original_filename: 'broken.heic',
        display_url: null,
      },
    ];
    await mockShareResolve(page, payload);
    await page.goto('/?t=e2e-test-token');
    await expect(page.locator('#surfaceLoadOverlay')).toBeHidden();
    await page.locator('.photo-card[data-id="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"]').click();
    await expect(page.locator('#lightboxOverlay')).toBeHidden();
    await expect(page.locator('#toastMessage')).toHaveText('Preview unavailable for this photo');
  });

  test('invalid token shows not found', async ({ page }) => {
    await page.route('**/functions/v1/share-resolve**', async (route) => {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Share not found', code: 'share_not_found' }),
      });
    });
    await page.goto('/?t=bad-token');
    await expect(page.locator('#shareError')).toHaveText(
      'This link is no longer valid and the requested photos are unavailable.',
    );
    await expect(page.locator('#shareErrorRetryBtn')).toBeHidden();
  });

  test('recovers from transient share-resolve failure without refresh', async ({ page }) => {
    let attempts = 0;
    await page.route('**/functions/v1/share-resolve**', async (route) => {
      attempts += 1;
      if (attempts <= 2) {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'Could not load share',
            code: 'share_unavailable',
          }),
        });
        return;
      }
      const url = new URL(route.request().url());
      if (url.searchParams.get('phase') === 'meta') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(MOCK_SHARE_META),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_SHARE),
      });
    });

    await page.goto('/?t=e2e-test-token');
    await expect(page.locator('#sharePageTitle')).toHaveText('E2E Test Album');
    await expect(page.locator('.photo-card')).toHaveCount(2);
    await expect(page.locator('#shareError')).toBeHidden();
  });

  test('shows try again after repeated share-resolve failures', async ({ page }) => {
    await page.route('**/functions/v1/share-resolve**', async (route) => {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'Could not load share',
          code: 'share_unavailable',
        }),
      });
    });

    await page.goto('/?t=e2e-test-token');
    await expect(page.locator('#shareError')).toHaveText(
      "Couldn't reach the share service. Check your connection and try again.",
    );
    await expect(page.locator('#shareErrorRetryBtn')).toBeVisible();

    await mockShareResolve(page);
    await page.locator('#shareErrorRetryBtn').click();
    await expect(page.locator('#sharePageTitle')).toHaveText('E2E Test Album');
    await expect(page.locator('.photo-card')).toHaveCount(2);
  });
});
