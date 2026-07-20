DO $$
DECLARE
  column_record RECORD;
BEGIN
  FOR column_record IN
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND data_type = 'uuid'
      AND (
        column_name = 'user_id'
        OR column_name LIKE '%user_id%'
        OR column_name IN ('locked_by', 'sender_id', 'receiver_id', 'initiated_by')
      )
    ORDER BY table_name, column_name
  LOOP
    EXECUTE format(
      'ALTER TABLE public.%I ALTER COLUMN %I TYPE TEXT USING %I::text',
      column_record.table_name,
      column_record.column_name,
      column_record.column_name
    );
  END LOOP;
END $$;
