import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const symbol = searchParams.get('symbol');
  const contractType = searchParams.get('contractType') || 'CALL';
  const includeQuotes = searchParams.get('includeQuotes') || 'true';
  const accessToken = request.headers.get('Authorization')?.replace('Bearer ', '');

  if (!symbol) {
    return NextResponse.json({ error: 'Missing symbol parameter' }, { status: 400 });
  }

  if (!accessToken) {
    return NextResponse.json({ error: 'Missing authorization token' }, { status: 401 });
  }

  try {
    const url = `https://api.schwabapi.com/marketdata/v1/chains?symbol=${encodeURIComponent(symbol)}&contractType=${contractType}&includeQuotes=${includeQuotes}`;
    
    console.log('Fetching options chain from Schwab:', url);
    
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Schwab options API error:', response.status, errorText);
      return NextResponse.json(
        { error: 'Schwab API error', details: errorText },
        { status: response.status }
      );
    }

    const data = await response.json();
    console.log('Options chain response keys:', Object.keys(data));
    return NextResponse.json(data);
  } catch (error) {
    console.error('Schwab options fetch error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch options chain' },
      { status: 500 }
    );
  }
}
