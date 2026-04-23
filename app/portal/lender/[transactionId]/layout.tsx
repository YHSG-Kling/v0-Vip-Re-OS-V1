import React from "react"

interface Props {
  children: React.ReactNode
  params: Promise<{ transactionId: string }>
}

export default function LenderTransactionLayout({ children }: Props) {
  return <>{children}</>
}
