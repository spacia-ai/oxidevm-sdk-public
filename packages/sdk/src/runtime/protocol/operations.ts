export interface Operation<Request, Response> {
  readonly request: Request;
  readonly response: Response;
}

export type OperationRequest<
  Operations,
  Name extends keyof Operations,
> = Operations[Name] extends Operation<infer Request, unknown>
  ? Request
  : never;

export type OperationResponse<
  Operations,
  Name extends keyof Operations,
> = Operations[Name] extends Operation<unknown, infer Response>
  ? Response
  : never;

export type OperationDecoders<Operations> = {
  readonly [Name in keyof Operations]: (
    value: unknown,
  ) => OperationResponse<Operations, Name>;
};
