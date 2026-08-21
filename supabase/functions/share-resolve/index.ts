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

type AlbumRow = {
  id: string;
  title: string | null;
  photo_count: number | null;
  created_at: string;
  revoked_at: string | null;
  expires_at: string | null;
};

type AlbumLookupResult =
  | { kind: "ok"; album: AlbumRow }
  | { kind: "not_found" }
  | { kind: "revoked" }
  | { kind: "expired" }
  | { kind: "db_error" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function unavailableResponse(message = "Could not load share") {
  return jsonResponse(
    { error: message, code: "share_unavailable" },
    503,
  );
}

function lookupErrorResponse(
  result: Exclude<AlbumLookupResult, { kind: "ok" }>,
): Response {
  switch (result.kind) {
    case "not_found":
      return jsonResponse(
        { error: "Share not found", code: "share_not_found" },
        404,
      );
    case "revoked":
      return jsonResponse(
        { error: "Share revoked", code: "share_revoked" },
        410,
      );
    case "expired":
      return jsonResponse(
        { error: "Share expired", code: "share_expired" },
        410,
      );
    case "db_error":
      return unavailableResponse();
  }
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

function dayKeyFromDateTaken(dateTaken: string | null): string {
  if (!dateTaken) {
    return "undated";
  }
  const date = new Date(dateTaken);
  if (Number.isNaN(date.getTime())) {
    return "undated";
  }
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseSortOrder(value: string | null): "newest" | "oldest" {
  return value === "newest" ? "newest" : "oldest";
}

const BROWSER_NATIVE_STILL_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
]);

function stillExtension(filename: string | null): string {
  if (!filename) {
    return "";
  }
  const dot = filename.lastIndexOf(".");
  if (dot < 0) {
    return "";
  }
  return filename.slice(dot).toLowerCase();
}

async function loadAlbumByToken(
  supabase: ReturnType<typeof createClient>,
  token: string,
): Promise<AlbumLookupResult> {
  const { data: album, error: albumError } = await supabase
    .from("albums")
    .select("id, title, photo_count, created_at, revoked_at, expires_at")
    .eq("access_token", token)
    .maybeSingle();

  if (albumError) {
    console.error("share-resolve album lookup failed", albumError.message);
    return { kind: "db_error" };
  }
  if (!album) {
    return { kind: "not_found" };
  }
  if (album.revoked_at) {
    return { kind: "revoked" };
  }
  if (album.expires_at) {
    const expiresAt = new Date(album.expires_at);
    if (!Number.isNaN(expiresAt.getTime()) && expiresAt <= new Date()) {
      return { kind: "expired" };
    }
  }
  return { kind: "ok", album };
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
    return jsonResponse(
      { error: "Server misconfigured", code: "share_misconfigured" },
      500,
    );
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const lookup = await loadAlbumByToken(supabase, token);
  if (lookup.kind !== "ok") {
    return lookupErrorResponse(lookup);
  }
  const album = lookup.album;

  if (phase === "meta") {
    let firstPhoto = null;
    try {
      firstPhoto = await loadFirstClusterPhoto(supabase, album.id, sort);
    } catch (error) {
      console.error("share-resolve meta query failed", error);
      return unavailableResponse();
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
        day_key: dayKeyFromDateTaken(dateTaken),
        date_taken: dateTaken,
      },
      sort,
    });
  }

  const { data: photoRows, error: photosError } = await supabase
    .from("album_photos")
    .select(
      "id, position, date_taken, file_type, width, height, rating, original_filename, thumb_path, original_path, display_path",
    )
    .eq("album_id", album.id)
    .order("position", { ascending: true });

  if (photosError) {
    console.error("share-resolve photos query failed", photosError.message);
    return unavailableResponse();
  }

  const photos = [];
  for (const photo of photoRows ?? []) {
    const displayStoragePath = photo.display_path;
    const signTargets = [
      supabase.storage
        .from(SHARE_BUCKET)
        .createSignedUrl(photo.thumb_path, SIGNED_URL_TTL_SECONDS),
      supabase.storage
        .from(SHARE_BUCKET)
        .createSignedUrl(photo.original_path, SIGNED_URL_TTL_SECONDS),
    ];
    if (displayStoragePath) {
      signTargets.push(
        supabase.storage
          .from(SHARE_BUCKET)
          .createSignedUrl(displayStoragePath, SIGNED_URL_TTL_SECONDS),
      );
    }

    const signResults = await Promise.all(signTargets);
    const thumbResult = signResults[0];
    const originalResult = signResults[1];
    const displayResult = displayStoragePath ? signResults[2] : null;

    if (thumbResult.error || originalResult.error) {
      console.error("share-resolve asset signing failed", {
        thumb: thumbResult.error?.message,
        original: originalResult.error?.message,
      });
      return unavailableResponse("Could not load share assets");
    }
    if (displayResult?.error) {
      console.error(
        "share-resolve display asset signing failed",
        displayResult.error.message,
      );
      return unavailableResponse("Could not load share assets");
    }

    let displayUrl: string | null = null;
    if (displayResult?.data?.signedUrl) {
      displayUrl = displayResult.data.signedUrl;
    } else if (photo.file_type === "video") {
      displayUrl = originalResult.data.signedUrl;
    } else if (
      BROWSER_NATIVE_STILL_EXTENSIONS.has(stillExtension(photo.original_filename))
    ) {
      displayUrl = originalResult.data.signedUrl;
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
      display_url: displayUrl,
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
