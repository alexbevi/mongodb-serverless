export async function initializeLazyClient<Client>(
  loadConnectionString: () => Promise<string>,
  createClient: (uri: string) => Client
): Promise<() => Client> {
  const uri = await loadConnectionString();

  let client: Client | undefined;

  return () => client ??= createClient(uri);
}
