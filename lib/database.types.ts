/**
 * Database types for the `public` schema.
 *
 * NOT produced by `supabase gen types` in this environment: that command shells
 * out to Docker to run postgres-meta even when given `--db-url`, and there is no
 * Docker daemon here (`npm run db:types` fails with LegacyDockerRunError). This
 * file was written by hand from `supabase/migrations/0001_init.sql`, checked
 * column by column against the catalog of a database built by
 * `./scripts/verify-db.sh` (names, types, nullability, defaults and foreign
 * keys all read back from `pg_attribute`/`pg_constraint`).
 *
 * Where Docker is available, `npm run db:types` regenerates it for real and
 * should overwrite this file wholesale.
 *
 * Mapping used, the same one the CLI uses: uuid/text/date/timestamptz -> string,
 * int/numeric -> number, jsonb -> Json, text[] -> string[]. `Insert` makes a
 * column optional when it is nullable or has a default; `Update` makes
 * everything optional. Note that the four columns revoked from `authenticated`
 * (stage_id, stage_entered_at, published_at, shipped_role), and the fifth added
 * by 0005 (checklist_seeded_stages), still appear in
 * `Update`: the types describe the schema, and the database — not the types —
 * is what refuses those writes.
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

/**
 * Named separately because `create_channel` returns a whole `channels` row.
 */
export type ChannelsRow = {
  id: string;
  user_id: string;
  created_at: string;
  name: string;
  slug: string;
  voice_guide: string | null;
  script_template: string;
  wip_threshold: number;
  stale_days: number;
  expected_ctr: number | null;
};

/**
 * Named separately because `move_video`, `swap_thumbnail` and `capture_video`
 * all return a whole `videos` row, and a type alias cannot reference itself.
 */
export type VideosRow = {
  id: string;
  user_id: string;
  created_at: string;
  channel_id: string;
  stage_id: string;
  stage_entered_at: string;
  updated_at: string | null;
  title: string;
  title_candidates: Json;
  thumbnail_concept: string | null;
  thumbnail_concept_path: string | null;
  hooks: Json;
  packaging_skipped_at: string | null;
  packaging_skip_reason: string | null;
  script: string | null;
  script_structure: string | null;
  end_screen_target: string | null;
  one_line_hook: string | null;
  notes: string | null;
  tags: string[];
  vertical_id: string | null;
  horizontal_id: string | null;
  vertical_axis: string;
  horizontal_axis: string;
  waiting_on: string | null;
  waiting_since: string | null;
  filming_day_id: string | null;
  target_publish_date: string | null;
  archived_at: string | null;
  thumb_wild_card_path: string | null;
  thumb_moderate_path: string | null;
  thumb_safe_path: string | null;
  shipped_role: string | null;
  youtube_url: string | null;
  published_at: string | null;
  first24_impressions: number | null;
  first24_ctr: number | null;
  first24_views: number | null;
  new_viewers_note: string | null;
  metrics_logged_at: string | null;
  swap_dismissed_at: string | null;
  brainstorm_last: Json | null;
  /**
   * Which stages this video has already entered (0005).
   *
   * Written only by `move_video` and `capture_video`. Like the four columns
   * named in the file comment above, it still appears in `Update` — these types
   * describe the schema, and the grant is what refuses the write.
   */
  checklist_seeded_stages: string[];
};

export type Database = {
  public: {
    Tables: {
      buckets: {
        Row: {
          id: string;
          user_id: string;
          created_at: string;
          channel_id: string;
          axis: string;
          name: string;
          position: number;
          monthly_quota: number | null;
        };
        Insert: {
          id?: string;
          user_id?: string;
          created_at?: string;
          channel_id: string;
          axis: string;
          name: string;
          position: number;
          monthly_quota?: number | null;
        };
        Update: {
          id?: string;
          user_id?: string;
          created_at?: string;
          channel_id?: string;
          axis?: string;
          name?: string;
          position?: number;
          monthly_quota?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "buckets_channel_id_user_id_fkey";
            columns: ["channel_id", "user_id"];
            isOneToOne: false;
            referencedRelation: "channels";
            referencedColumns: ["id", "user_id"];
          },
        ];
      };
      channels: {
        Row: ChannelsRow;
        Insert: {
          id?: string;
          user_id?: string;
          created_at?: string;
          name: string;
          slug: string;
          voice_guide?: string | null;
          script_template: string;
          wip_threshold?: number;
          stale_days?: number;
          expected_ctr?: number | null;
        };
        Update: {
          id?: string;
          user_id?: string;
          created_at?: string;
          name?: string;
          slug?: string;
          voice_guide?: string | null;
          script_template?: string;
          wip_threshold?: number;
          stale_days?: number;
          expected_ctr?: number | null;
        };
        Relationships: [];
      };
      checklist_items: {
        Row: {
          id: string;
          user_id: string;
          created_at: string;
          video_id: string;
          channel_id: string;
          stage_id: string;
          text: string;
          position: number;
          est_minutes: number | null;
          checked_at: string | null;
        };
        Insert: {
          id?: string;
          user_id?: string;
          created_at?: string;
          video_id: string;
          channel_id: string;
          stage_id: string;
          text: string;
          position: number;
          est_minutes?: number | null;
          checked_at?: string | null;
        };
        Update: {
          id?: string;
          user_id?: string;
          created_at?: string;
          video_id?: string;
          channel_id?: string;
          stage_id?: string;
          text?: string;
          position?: number;
          est_minutes?: number | null;
          checked_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "checklist_items_stage_id_user_id_fkey";
            columns: ["stage_id", "user_id"];
            isOneToOne: false;
            referencedRelation: "stages";
            referencedColumns: ["id", "user_id"];
          },
          {
            foreignKeyName: "checklist_items_video_id_user_id_fkey";
            columns: ["video_id", "user_id"];
            isOneToOne: false;
            referencedRelation: "videos";
            referencedColumns: ["id", "user_id"];
          },
          {
            foreignKeyName: "checklist_items_stage_id_channel_id_fkey";
            columns: ["stage_id", "channel_id"];
            isOneToOne: false;
            referencedRelation: "stages";
            referencedColumns: ["id", "channel_id"];
          },
          {
            foreignKeyName: "checklist_items_video_id_channel_id_fkey";
            columns: ["video_id", "channel_id"];
            isOneToOne: false;
            referencedRelation: "videos";
            referencedColumns: ["id", "channel_id"];
          },
        ];
      };
      checklist_templates: {
        Row: {
          id: string;
          user_id: string;
          created_at: string;
          stage_id: string;
          text: string;
          position: number;
          est_minutes: number;
        };
        Insert: {
          id?: string;
          user_id?: string;
          created_at?: string;
          stage_id: string;
          text: string;
          position: number;
          est_minutes: number;
        };
        Update: {
          id?: string;
          user_id?: string;
          created_at?: string;
          stage_id?: string;
          text?: string;
          position?: number;
          est_minutes?: number;
        };
        Relationships: [
          {
            foreignKeyName: "checklist_templates_stage_id_user_id_fkey";
            columns: ["stage_id", "user_id"];
            isOneToOne: false;
            referencedRelation: "stages";
            referencedColumns: ["id", "user_id"];
          },
        ];
      };
      filming_days: {
        Row: {
          id: string;
          user_id: string;
          created_at: string;
          on_date: string;
          notes: string | null;
        };
        Insert: {
          id?: string;
          user_id?: string;
          created_at?: string;
          on_date: string;
          notes?: string | null;
        };
        Update: {
          id?: string;
          user_id?: string;
          created_at?: string;
          on_date?: string;
          notes?: string | null;
        };
        Relationships: [];
      };
      stages: {
        Row: {
          id: string;
          user_id: string;
          created_at: string;
          channel_id: string;
          name: string;
          position: number;
          kind: string | null;
          is_enabled: boolean;
        };
        Insert: {
          id?: string;
          user_id?: string;
          created_at?: string;
          channel_id: string;
          name: string;
          position: number;
          kind?: string | null;
          is_enabled?: boolean;
        };
        Update: {
          id?: string;
          user_id?: string;
          created_at?: string;
          channel_id?: string;
          name?: string;
          position?: number;
          kind?: string | null;
          is_enabled?: boolean;
        };
        Relationships: [
          {
            foreignKeyName: "stages_channel_id_user_id_fkey";
            columns: ["channel_id", "user_id"];
            isOneToOne: false;
            referencedRelation: "channels";
            referencedColumns: ["id", "user_id"];
          },
        ];
      };
      /**
       * 0010. One row per user: the zone "today" is computed in. Readable by
       * its owner; written only by `set_time_zone()`.
       */
      profiles: {
        Row: {
          id: string;
          user_id: string;
          created_at: string;
          updated_at: string;
          time_zone: string;
          time_zone_source: "detected" | "chosen";
        };
        Insert: {
          id?: string;
          user_id?: string;
          created_at?: string;
          updated_at?: string;
          time_zone: string;
          time_zone_source: "detected" | "chosen";
        };
        Update: {
          id?: string;
          user_id?: string;
          created_at?: string;
          updated_at?: string;
          time_zone?: string;
          time_zone_source?: "detected" | "chosen";
        };
        Relationships: [];
      };
      thumbnail_swaps: {
        Row: {
          id: string;
          user_id: string;
          created_at: string;
          video_id: string;
          from_role: string | null;
          to_role: string;
          reason: string;
          swapped_at: string;
        };
        Insert: {
          id?: string;
          user_id?: string;
          created_at?: string;
          video_id: string;
          from_role?: string | null;
          to_role: string;
          reason: string;
          swapped_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          created_at?: string;
          video_id?: string;
          from_role?: string | null;
          to_role?: string;
          reason?: string;
          swapped_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "thumbnail_swaps_video_id_user_id_fkey";
            columns: ["video_id", "user_id"];
            isOneToOne: false;
            referencedRelation: "videos";
            referencedColumns: ["id", "user_id"];
          },
        ];
      };
      videos: {
        Row: VideosRow;
        Insert: {
          id?: string;
          user_id?: string;
          created_at?: string;
          channel_id: string;
          stage_id: string;
          stage_entered_at?: string;
          updated_at?: string | null;
          title?: string;
          title_candidates?: Json;
          thumbnail_concept?: string | null;
          thumbnail_concept_path?: string | null;
          hooks?: Json;
          packaging_skipped_at?: string | null;
          packaging_skip_reason?: string | null;
          script?: string | null;
          script_structure?: string | null;
          end_screen_target?: string | null;
          one_line_hook?: string | null;
          notes?: string | null;
          tags?: string[];
          vertical_id?: string | null;
          horizontal_id?: string | null;
          vertical_axis?: string;
          horizontal_axis?: string;
          waiting_on?: string | null;
          waiting_since?: string | null;
          filming_day_id?: string | null;
          target_publish_date?: string | null;
          archived_at?: string | null;
          thumb_wild_card_path?: string | null;
          thumb_moderate_path?: string | null;
          thumb_safe_path?: string | null;
          shipped_role?: string | null;
          youtube_url?: string | null;
          published_at?: string | null;
          first24_impressions?: number | null;
          first24_ctr?: number | null;
          first24_views?: number | null;
          new_viewers_note?: string | null;
          metrics_logged_at?: string | null;
          swap_dismissed_at?: string | null;
          brainstorm_last?: Json | null;
          checklist_seeded_stages?: string[];
        };
        Update: {
          id?: string;
          user_id?: string;
          created_at?: string;
          channel_id?: string;
          stage_id?: string;
          stage_entered_at?: string;
          updated_at?: string | null;
          title?: string;
          title_candidates?: Json;
          thumbnail_concept?: string | null;
          thumbnail_concept_path?: string | null;
          hooks?: Json;
          packaging_skipped_at?: string | null;
          packaging_skip_reason?: string | null;
          script?: string | null;
          script_structure?: string | null;
          end_screen_target?: string | null;
          one_line_hook?: string | null;
          notes?: string | null;
          tags?: string[];
          vertical_id?: string | null;
          horizontal_id?: string | null;
          vertical_axis?: string;
          horizontal_axis?: string;
          waiting_on?: string | null;
          waiting_since?: string | null;
          filming_day_id?: string | null;
          target_publish_date?: string | null;
          archived_at?: string | null;
          thumb_wild_card_path?: string | null;
          thumb_moderate_path?: string | null;
          thumb_safe_path?: string | null;
          shipped_role?: string | null;
          youtube_url?: string | null;
          published_at?: string | null;
          first24_impressions?: number | null;
          first24_ctr?: number | null;
          first24_views?: number | null;
          new_viewers_note?: string | null;
          metrics_logged_at?: string | null;
          swap_dismissed_at?: string | null;
          brainstorm_last?: Json | null;
          checklist_seeded_stages?: string[];
        };
        Relationships: [
          {
            foreignKeyName: "videos_channel_id_user_id_fkey";
            columns: ["channel_id", "user_id"];
            isOneToOne: false;
            referencedRelation: "channels";
            referencedColumns: ["id", "user_id"];
          },
          {
            foreignKeyName: "videos_filming_day_id_user_id_fkey";
            columns: ["filming_day_id", "user_id"];
            isOneToOne: false;
            referencedRelation: "filming_days";
            referencedColumns: ["id", "user_id"];
          },
          {
            foreignKeyName: "videos_horizontal_id_channel_id_horizontal_axis_fkey";
            columns: ["horizontal_id", "channel_id", "horizontal_axis"];
            isOneToOne: false;
            referencedRelation: "buckets";
            referencedColumns: ["id", "channel_id", "axis"];
          },
          {
            foreignKeyName: "videos_stage_id_channel_id_fkey";
            columns: ["stage_id", "channel_id"];
            isOneToOne: false;
            referencedRelation: "stages";
            referencedColumns: ["id", "channel_id"];
          },
          {
            foreignKeyName: "videos_stage_id_user_id_fkey";
            columns: ["stage_id", "user_id"];
            isOneToOne: false;
            referencedRelation: "stages";
            referencedColumns: ["id", "user_id"];
          },
          {
            foreignKeyName: "videos_vertical_id_channel_id_vertical_axis_fkey";
            columns: ["vertical_id", "channel_id", "vertical_axis"];
            isOneToOne: false;
            referencedRelation: "buckets";
            referencedColumns: ["id", "channel_id", "axis"];
          },
        ];
      };
    };
    Views: { [_ in never]: never };
    Functions: {
      capture_video: {
        Args: { p_channel: string; p_title?: string };
        Returns: VideosRow;
      };
      create_channel: {
        Args: {
          p_name: string;
          p_slug: string;
          p_script_template: string;
          p_wip_threshold: number;
          p_stale_days: number;
          p_expected_ctr: number | null;
          p_voice_guide: string | null;
          p_stages: Json;
          p_buckets: Json;
        };
        Returns: ChannelsRow;
      };
      move_video: {
        Args: {
          p_video: string;
          p_stage: string;
          p_published_at?: string | null;
        };
        Returns: VideosRow;
      };
      swap_thumbnail: {
        Args: { p_video: string; p_to_role: string; p_reason: string };
        Returns: VideosRow;
      };
      reorder_stages: {
        Args: { p_channel: string; p_stage_ids: string[] };
        Returns: Database["public"]["Tables"]["stages"]["Row"][];
      };
      set_stage_enabled: {
        Args: { p_stage: string; p_enabled: boolean };
        Returns: Database["public"]["Tables"]["stages"]["Row"];
      };
      set_video_archived: {
        Args: { p_video: string; p_archived: boolean };
        Returns: VideosRow;
      };
      /**
       * 0009. The only write path to `videos.brainstorm_last`: it merges one
       * kind's entry into whatever the column holds, in one statement, so two
       * brainstorms in flight at once cannot overwrite each other's answer
       * with a snapshot taken before either of them ran.
       */
      merge_brainstorm_entry: {
        Args: { p_video: string; p_kind: string; p_entry: Json };
        Returns: boolean;
      };
      /**
       * 0010. Records the user's zone. `p_detected` never overwrites an
       * existing row; a choice always does. Refuses (22023) a name the
       * database's tz catalogue does not know.
       */
      set_time_zone: {
        Args: { p_zone: string; p_detected?: boolean };
        Returns: Database["public"]["Tables"]["profiles"]["Row"];
      };
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};

/* ---- The convenience aliases `supabase gen types` appends. --------------- */

type PublicSchema = Database["public"];

export type Tables<T extends keyof PublicSchema["Tables"]> =
  PublicSchema["Tables"][T]["Row"];

export type TablesInsert<T extends keyof PublicSchema["Tables"]> =
  PublicSchema["Tables"][T]["Insert"];

export type TablesUpdate<T extends keyof PublicSchema["Tables"]> =
  PublicSchema["Tables"][T]["Update"];
