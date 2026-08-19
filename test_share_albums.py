import unittest

from share_albums import (
    build_share_url,
    format_album_label,
    format_album_created_date,
    generate_access_token,
    generate_share_slug,
    suggest_share_title,
)


class ShareAlbumsTest(unittest.TestCase):
    def test_generate_share_slug_length(self):
        slug = generate_share_slug(12)
        self.assertEqual(len(slug), 12)
        self.assertTrue(slug.isalnum())
        self.assertTrue(slug.islower() or any(ch.isdigit() for ch in slug))

    def test_generate_access_token_length(self):
        token = generate_access_token(32)
        self.assertEqual(len(token), 32)

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
            build_share_url("abc123token", "https://example.com/viewer"),
            "https://example.com/viewer/?t=abc123token",
        )

    def test_format_album_label_with_title(self):
        label = format_album_label(
            "Tahoe Fun Times",
            "2026-08-18T12:00:00+00:00",
        )
        self.assertEqual(label, "Tahoe Fun Times (Aug 18 2026)")

    def test_format_album_label_without_title(self):
        label = format_album_label(None, "2026-08-17T12:00:00+00:00")
        self.assertEqual(label, "Aug 17 2026")

    def test_format_album_created_date(self):
        self.assertEqual(
            format_album_created_date("2026-08-18T12:00:00+00:00"),
            "Aug 18 2026",
        )

    def test_format_album_created_date_postgres_fractional_seconds(self):
        self.assertEqual(
            format_album_created_date("2026-08-18T23:59:40.19901+00:00"),
            "Aug 18 2026",
        )
        self.assertEqual(
            format_album_created_date("2026-08-18T23:48:42.95229+00:00"),
            "Aug 18 2026",
        )


if __name__ == "__main__":
    unittest.main()
