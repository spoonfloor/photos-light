import unittest

import app as photo_app


class ThumbnailEndpointTests(unittest.TestCase):
    def setUp(self):
        photo_app.clear_library_session()

    def test_thumbnail_returns_503_when_library_not_configured(self):
        with photo_app.app.test_request_context():
            response, status_code = photo_app.get_photo_thumbnail(1)
        self.assertEqual(status_code, 503)
        self.assertEqual(response.get_json()['error'], 'Library not configured')


if __name__ == '__main__':
    unittest.main()
