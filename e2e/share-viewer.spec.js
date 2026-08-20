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
    await mockShareResolve(page);
    await page.goto('/?t=e2e-test-token', { waitUntil: 'commit' });

    await expect(page.locator('body')).toHaveClass(/surface-load-active/);
    await expect(page.locator('#surfaceLoadOverlay')).toBeVisible();
    await expect(page.locator('[data-filter="recentImports"]')).toHaveCount(0);
    await expect(page.locator('#addPhotoBtn')).toBeHidden();

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

  test('utilities menu shows copy link without manage links', async ({ page }) => {
    await mockShareResolve(page);
    await page.goto('/?t=e2e-test-token');
    await expect(page.locator('#surfaceLoadOverlay')).toBeHidden();
    await page.locator('#utilitiesBtn').click();
    await expect(page.locator('#copyShareLinkBtn')).toBeVisible();
    await expect(page.locator('#copyShareLinkBtn')).toHaveText(/Copy link/);
    await expect(page.locator('#manageShareLinksBtn')).toHaveCount(0);
    await expect(page.locator('#getShareLinkBtn')).toHaveCount(0);
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
        body: JSON.stringify({ error: 'Share not found' }),
      });
    });
    await page.goto('/?t=bad-token');
    await expect(page.locator('#shareError')).toHaveText(
      'This link is no longer valid and the requested photos are unavailable.',
    );
  });
});
