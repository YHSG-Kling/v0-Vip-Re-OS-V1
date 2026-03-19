export function calculateDaysOnMarket(listingDate: string | null): number | null {
  if (!listingDate) return null
  const listed = new Date(listingDate)
  const today = new Date()
  const diffTime = Math.abs(today.getTime() - listed.getTime())
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24))
}

export function formatPrice(price: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(price)
}
