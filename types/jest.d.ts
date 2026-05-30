/**
 * Type declarations for Jest testing framework
 * Used by test files throughout the project
 */

declare function describe(name: string, fn: () => void): void
declare function test(name: string, fn: () => void | Promise<void>): void
declare function it(name: string, fn: () => void | Promise<void>): void
declare function beforeEach(fn: () => void | Promise<void>): void
declare function afterEach(fn: () => void | Promise<void>): void
declare function beforeAll(fn: () => void | Promise<void>): void
declare function afterAll(fn: () => void | Promise<void>): void

declare function expect(value: any): jest.Matchers<any>

declare namespace jest {
  interface Matchers<R> {
    toBe(expected: any): R
    toEqual(expected: any): R
    toStrictEqual(expected: any): R
    toBeTruthy(): R
    toBeFalsy(): R
    toBeNull(): R
    toBeUndefined(): R
    toBeDefined(): R
    toBeNaN(): R
    toBeGreaterThan(n: number): R
    toBeGreaterThanOrEqual(n: number): R
    toBeLessThan(n: number): R
    toBeLessThanOrEqual(n: number): R
    toBeCloseTo(n: number, numDigits?: number): R
    toContain(item: any): R
    toContainEqual(item: any): R
    toHaveLength(n: number): R
    toHaveProperty(keyPath: string | string[], value?: any): R
    toMatch(pattern: string | RegExp): R
    toMatchObject(obj: any): R
    toMatchSnapshot(propertyMatchers?: any, hint?: string): R
    toThrow(error?: string | RegExp | Error): R
    toThrowError(error?: string | RegExp | Error): R
    toHaveBeenCalled(): R
    toHaveBeenCalledTimes(n: number): R
    toHaveBeenCalledWith(...args: any[]): R
    toHaveBeenLastCalledWith(...args: any[]): R
    toHaveBeenNthCalledWith(n: number, ...args: any[]): R
    toHaveReturned(): R
    toHaveReturnedTimes(n: number): R
    toHaveReturnedWith(value: any): R
    toHaveLastReturnedWith(value: any): R
    toHaveNthReturnedWith(n: number, value: any): R
    resolves: Matchers<Promise<R>>
    rejects: Matchers<Promise<R>>
    not: Matchers<R>
  }

  function fn<T extends (...args: any[]) => any>(implementation?: T): Mock<T>
  function spyOn<T extends {}, M extends keyof T>(
    object: T,
    method: M
  ): Mock<T[M] extends (...args: any[]) => any ? T[M] : never>

  interface Mock<T = any> {
    (...args: any[]): any
    mockClear(): this
    mockReset(): this
    mockRestore(): void
    mockImplementation(fn: T): this
    mockImplementationOnce(fn: T): this
    mockReturnValue(value: any): this
    mockReturnValueOnce(value: any): this
    mockResolvedValue(value: any): this
    mockResolvedValueOnce(value: any): this
    mockRejectedValue(value: any): this
    mockRejectedValueOnce(value: any): this
    mockName(name: string): this
  }
}
