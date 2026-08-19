import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SHARE_BUCKET = "shares";
const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24;

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function albumIsAccessible(album: {
  revoked_at: string | null;
  expires_at: string | null;
}): boolean {
  if (album.revoked_at) {
    return false;
  }
  if (album.expires_at) {
    const expiresAt = new Date(album.expires_at);
    if (!Number.isNaN(expiresAt.getTime()) && expiresAt <= new Date()) {
      return false;
    }
  }
  return true;
}

function monthKeyFromDateTaken(dateTaken: string | null): string {
  if (!dateTaken) {
    return "undated";
  }
  const date = new Date(dateTaken);
  if (Number.isNaN(date.getTime())) {
    return "undated";
  }
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function parseSortOrder(value: string | null): "newest" | "oldest" {
  return value === "oldest" ? "oldest" : "newest";
}

async function loadAlbumByToken(supabase: ReturnType<typeof createClient>, token: string) {
  const { data: album, error: albumError } = await supabase
    .from("albums")
    .select("id, title, photo_count, created_at, revoked_at, expires_at")
    .eq("access_token", token)
    .maybeSingle();

  if (albumError || !album || !albumIsAccessible(album)) {
    return null;
  }
  return album;
}

async function loadFirstClusterPhoto(
  supabase: ReturnType<typeof createClient>,
  albumId: string,
  sort: "newest" | "oldest",
) {
  const ascending = sort === "oldest";
  const { data: firstPhoto, error } = await supabase
    .from("album_photos")
    .select("date_taken")
    .eq("album_id", albumId)
    .order("date_taken", { ascending, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }
  return firstPhoto;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const url = new URL(req.url);
  const token = url.searchParams.get("token")?.trim();
  if (!token) {
    return jsonResponse({ error: "Missing token" }, 400);
  }

  const phase = url.searchParams.get("phase");
  const sort = parseSortOrder(url.searchParams.get("sort"));

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "Server misconfigured" }, 500);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const album = await loadAlbumByToken(supabase, token);
  if (!album) {
    return jsonResponse({ error: "Share not found" }, 404);
  }

  if (phase === "meta") {
    let firstPhoto = null;
    try {
      firstPhoto = await loadFirstClusterPhoto(supabase, album.id, sort);
    } catch {
      return jsonResponse({ error: "Could not load share" }, 500);
    }

    const dateTaken = firstPhoto?.date_taken ?? null;
    return jsonResponse({
      album: {
        id: album.id,
        title: album.title,
        photo_count: album.photo_count,
        created_at: album.created_at,
      },
      first_cluster: {
        month_key: monthKeyFromDateTaken(dateTaken),
        date_taken: dateTaken,
      },
      sort,
    });
  }

  const { data: photoRows, error: photosError } = await supabase
    .from("album_photos")
    .select(
      "id, position, date_taken, file_type, width, height, rating, original_filename, thumb_path, original_path",
    )
    .eq("album_id", album.id)
    .order("position", { ascending: true });

  if (photosError) {
    return jsonResponse({ error: "Could not load share" }, 500);
  }

  const photos = [];
  for (const photo of photoRows ?? []) {
    const [thumbResult, originalResult] = await Promise.all([
      supabase.storage
        .from(SHARE_BUCKET)
        .createSignedUrl(photo.thumb_path, SIGNED_URL_TTL_SECONDS),
      supabase.storage
        .from(SHARE_BUCKET)
        .createSignedUrl(photo.original_path, SIGNED_URL_TTL_SECONDS),
    ]);

    if (thumbResult.error || originalResult.error) {
      return jsonResponse({ error: "Could not load share assets" }, 500);
    }

    photos.push({
      id: photo.id,
      position: photo.position,
      date_taken: photo.date_taken,
      file_type: photo.file_type,
      width: photo.width,
      height: photo.height,
      rating: photo.rating,
      original_filename: photo.original_filename,
      thumb_url: thumbResult.data.signedUrl,
      original_url: originalResult.data.signedUrl,
    });
  }

  return jsonResponse({
    album: {
      id: album.id,
      title: album.title,
      photo_count: album.photo_count,
      created_at: album.created_at,
    },
    photos,
  });
});
