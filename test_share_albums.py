import unittest

from share_albums import generate_share_slug, suggest_share_title, build_share_url


class ShareAlbumsTest(unittest.TestCase):
    def test_generate_share_slug_length(self):
        slug = generate_share_slug(12)
        self.assertEqual(len(slug), 12)
        self.assertTrue(slug.isalnum())
        self.assertTrue(slug.islower() or any(ch.isdigit() for ch in slug))

    def test_suggest_share_title_single_day(self):
        title = suggest_share_title(["2026:02:26 14:30:00", "2026:02:26 09:00:00"])
        self.assertEqual(title, "Feb 26 Photos")

    def test_suggest_share_title_single_month(self):
        title = suggest_share_title(["2026:02:01 10:00:00", "2026:02:20 10:00:00"])
        self.assertEqual(title, "February 2026 Photos")

    def test_build_share_url(self):
        import os

        os.environ["SHARE_VIEWER_BASE_URL"] = "https://example.com/viewer"
        self.assertEqual(
            build_share_url("abc123", "https://example.com/viewer"),
            "https://example.com/viewer/?s=abc123",
        )


if __name__ == "__main__":
    unittest.main()
