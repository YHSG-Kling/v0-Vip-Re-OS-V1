-- Add feedback columns to open_house_attendees that submitFeedback updates
alter table open_house_attendees
  add column if not exists feedback_rating integer,
  add column if not exists feedback_comments text,
  add column if not exists feedback_collected_at timestamp with time zone;
