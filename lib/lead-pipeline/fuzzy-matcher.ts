export interface FuzzyMatchResult {
  score: number
  details: {
    nameScore: number
    emailScore: number
    phoneScore: number
    nameWeight: number
    emailWeight: number
    phoneWeight: number
  }
}

export function calculateFuzzyMatch(
  record1: { first_name?: string | null; last_name?: string | null; email?: string | null; phone?: string | null },
  record2: { first_name?: string | null; last_name?: string | null; email?: string | null; phone?: string | null }
): FuzzyMatchResult {
  
  let totalScore = 0
  let totalWeight = 0
  
  const details = {
    nameScore: 0,
    emailScore: 0,
    phoneScore: 0,
    nameWeight: 0,
    emailWeight: 0,
    phoneWeight: 0,
  }

  if (record1.first_name && record1.last_name && record2.first_name && record2.last_name) {
    const name1 = `${record1.first_name} ${record1.last_name}`.toLowerCase().trim()
    const name2 = `${record2.first_name} ${record2.last_name}`.toLowerCase().trim()
    
    const distance = levenshteinDistance(name1, name2)
    const maxLength = Math.max(name1.length, name2.length)
    const nameScore = maxLength > 0 ? 1 - (distance / maxLength) : 0

    details.nameScore = nameScore
    details.nameWeight = 0.3
    totalScore += nameScore * 0.3
    totalWeight += 0.3
  }

  if (record1.email && record2.email) {
    const email1 = record1.email.toLowerCase().trim()
    const email2 = record2.email.toLowerCase().trim()
    const emailScore = email1 === email2 ? 1.0 : 0.0

    details.emailScore = emailScore
    details.emailWeight = 0.35
    totalScore += emailScore * 0.35
    totalWeight += 0.35
  }

  if (record1.phone && record2.phone) {
    const phone1 = normalizePhone(record1.phone)
    const phone2 = normalizePhone(record2.phone)
    const phoneScore = phone1 === phone2 ? 1.0 : 0.0

    details.phoneScore = phoneScore
    details.phoneWeight = 0.35
    totalScore += phoneScore * 0.35
    totalWeight += 0.35
  }

  const finalScore = totalWeight > 0 ? totalScore / totalWeight : 0

  return {
    score: finalScore,
    details,
  }
}

function levenshteinDistance(str1: string, str2: string): number {
  const m = str1.length
  const n = str2.length
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0))

  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (str1[i - 1] === str2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1]
      } else {
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,
          dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + 1
        )
      }
    }
  }

  return dp[m][n]
}

function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, '')
}
