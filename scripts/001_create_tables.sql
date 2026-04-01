-- Create stock_positions table
CREATE TABLE IF NOT EXISTS public.stock_positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  shares INTEGER NOT NULL,
  cost_basis NUMERIC(12, 2) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create option_positions table
CREATE TABLE IF NOT EXISTS public.option_positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('call', 'put')),
  position TEXT NOT NULL CHECK (position IN ('long', 'short')),
  strike NUMERIC(12, 2) NOT NULL,
  expiration DATE NOT NULL,
  contracts INTEGER NOT NULL,
  entry_premium NUMERIC(12, 4) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable Row Level Security
ALTER TABLE public.stock_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.option_positions ENABLE ROW LEVEL SECURITY;

-- RLS policies for stock_positions
CREATE POLICY "stock_positions_select_own" ON public.stock_positions 
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "stock_positions_insert_own" ON public.stock_positions 
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "stock_positions_update_own" ON public.stock_positions 
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "stock_positions_delete_own" ON public.stock_positions 
  FOR DELETE USING (auth.uid() = user_id);

-- RLS policies for option_positions
CREATE POLICY "option_positions_select_own" ON public.option_positions 
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "option_positions_insert_own" ON public.option_positions 
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "option_positions_update_own" ON public.option_positions 
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "option_positions_delete_own" ON public.option_positions 
  FOR DELETE USING (auth.uid() = user_id);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_stock_positions_user_id ON public.stock_positions(user_id);
CREATE INDEX IF NOT EXISTS idx_option_positions_user_id ON public.option_positions(user_id);
