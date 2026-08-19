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
    },
  ],
};

const MOCK_SHARE_META = {
  album: MOCK_SHARE.album,
  first_cluster: {
    month_key: '2026-02',
    date_taken: '2026-02-26T15:00:00Z',
  },
  sort: 'newest',
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
    await expect(page.locator('.share-skeleton-card')).not.toHaveCount(0);
    await expect(page.locator('#sharePageTitle')).toHaveClass(/share-layout-placeholder/);
    await expect(page.locator('.month-label')).toHaveClass(/share-layout-placeholder/);
    expect(metaReleased).toBe(false);

    await expect(page.locator('#sharePageTitle')).not.toHaveClass(/share-layout-placeholder/, {
      timeout: 5000,
    });
    await expect(page.locator('.month-label')).toHaveText('February 2026');
    await expect(page.locator('.photo-card[data-id]')).toHaveCount(2, {
      timeout: 5000,
    });
  });

  test('star toggle updates card without full rebuild', async ({ page }) => {
    await mockShareResolve(page);
    await page.goto('/?t=e2e-test-token');
    const unstarredCard = page.locator('.photo-card[data-id="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"]');
    await expect(unstarredCard).not.toHaveClass(/is-starred/);
    await unstarredCard.locator('.star-badge').click({ force: true });
    await expect(unstarredCard).toHaveClass(/is-starred/);
    await expect(page.locator('.photo-card')).toHaveCount(2);
  });

  test('selection circle toggles selected state', async ({ page }) => {
    await mockShareResolve(page);
    await page.goto('/?t=e2e-test-token');
    const firstCard = page.locator('.photo-card[data-id="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"]');
    await firstCard.locator('.select-circle').click();
    await expect(firstCard).toHaveClass(/\bselected\b/);
    await expect(page.locator('#deselectAllBtn')).not.toHaveClass(/inactive/);
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
