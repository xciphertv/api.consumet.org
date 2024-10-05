import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { META, PROVIDERS_LIST } from '@consumet/extensions';
import Redis from 'ioredis';
import { tmdbApi } from '../../main';
import { LRUCache } from 'lru-cache';  // Updated import statement

declare module 'fastify' {
  interface FastifyInstance {
    redis: Redis | null;
    memoryCache: LRUCache<string, any>;
  }
}

type QueryParams = { query: string };
type InfoParams = { id: string };
type WatchParams = { episodeId: string };

type QueryString = {
  page?: number;
  type?: string;
  provider?: string;
  id?: string;
  timePeriod?: 'day' | 'week';
};

const VALID_TIME_PERIODS = new Set(['day', 'week'] as const);
type ValidTimeType = typeof VALID_TIME_PERIODS extends Set<infer T> ? T : never;

const CACHE_TTL = 1800; // 10 minutes in seconds

// Singleton TMDB instance
const tmdbInstance = new META.TMDB(tmdbApi);

// Initialize LRU Cache with a max size and TTL in milliseconds
const memoryCache = new LRUCache<string, any>({ max: 1000, ttl: CACHE_TTL * 1000 });

const createTMDB = (provider?: string) => {
  if (provider) {
    const possibleProvider = PROVIDERS_LIST.MOVIES.find(
      (p) => p.name.toLowerCase() === provider.toLowerCase()
    );
    return new META.TMDB(tmdbApi, possibleProvider);
  }
  return tmdbInstance;
};

const handleErrors = (reply: FastifyReply, error: unknown) => {
  console.error('Error:', error);
  reply.status(500).send({ message: 'An unexpected error occurred. Please try again later.' });
};

const getCacheKey = (route: string, params: Record<string, any>): string => {
  return `tmdb:${route}:${JSON.stringify(params)}`;
};

const cacheWrapper = async <T>(
  fastify: FastifyInstance,
  cacheKey: string,
  fetchData: () => Promise<T>,
  reply: FastifyReply
): Promise<T> => {
  // Check in-memory cache first
  const memoryCachedData = fastify.memoryCache.get(cacheKey);
  if (memoryCachedData) {
    reply.header('X-Cache', 'HIT-MEMORY');
    return memoryCachedData;
  }

  // Check Redis cache
  if (fastify.redis) {
    const cachedData = await fastify.redis.get(cacheKey);
    if (cachedData) {
      const parsedData = JSON.parse(cachedData);
      fastify.memoryCache.set(cacheKey, parsedData); // Store in in-memory cache for faster future access
      reply.header('X-Cache', 'HIT-REDIS');
      return parsedData;
    }
  }

  // If no cache, fetch data
  reply.header('X-Cache', 'MISS');
  const data = await fetchData();

  // Store in both caches
  fastify.memoryCache.set(cacheKey, data);
  if (fastify.redis) {
    fastify.redis.set(cacheKey, JSON.stringify(data), 'EX', CACHE_TTL);
  }

  return data;
};

const routes = async (fastify: FastifyInstance) => {
  // Add in-memory cache to Fastify instance
  fastify.decorate('memoryCache', memoryCache);

  fastify.get('/', (_, reply) => {
    reply.send({
      intro: "Welcome to the TMDB provider: check out the provider's website @ https://www.themoviedb.org/",
      routes: ['/:query', '/info/:id', '/watch/:episodeId', '/trending'],
      documentation: 'https://docs.consumet.org/#tag/tmdb',
    });
  });

  const fetchAndCache = async (
    fastify: FastifyInstance,
    cacheKey: string,
    fetchData: () => Promise<any>,
    reply: FastifyReply
  ) => {
    try {
      const res = await cacheWrapper(fastify, cacheKey, fetchData, reply);
      reply.send(res);
    } catch (error) {
      handleErrors(reply, error);
    }
  };

  fastify.get<{ Params: QueryParams; Querystring: QueryString }>(
    '/:query',
    async (request, reply) => {
      const { query } = request.params;
      const { page = 1 } = request.query;
      const cacheKey = getCacheKey('search', { query, page });

      await fetchAndCache(fastify, cacheKey, () => {
        const tmdb = createTMDB();
        return tmdb.search(query, page);
      }, reply);
    }
  );

  fastify.get<{ Params: InfoParams; Querystring: QueryString }>(
    '/info/:id',
    async (request, reply) => {
      const { id } = request.params;
      const { type, provider } = request.query;

      if (!type) {
        return reply.status(400).send({ message: "The 'type' query parameter is required" });
      }

      const cacheKey = getCacheKey('info', { id, type, provider });

      await fetchAndCache(fastify, cacheKey, () => {
        const tmdb = createTMDB(provider);
        return tmdb.fetchMediaInfo(id, type);
      }, reply);
    }
  );

  fastify.get<{ Querystring: QueryString }>(
    '/trending',
    async (request, reply) => {
      const { type = 'all', timePeriod = 'day', page = 1 } = request.query;
      const validTimePeriod = VALID_TIME_PERIODS.has(timePeriod as ValidTimeType)
        ? timePeriod as ValidTimeType
        : 'day';
      const cacheKey = getCacheKey('trending', { type, timePeriod: validTimePeriod, page });

      await fetchAndCache(fastify, cacheKey, () => {
        return tmdbInstance.fetchTrending(type, validTimePeriod, page);
      }, reply);
    }
  );

  fastify.get<{ Params: WatchParams; Querystring: QueryString }>(
    '/watch/:episodeId',
    async (request, reply) => {
      const { episodeId } = request.params;
      const { id, provider } = request.query;

      if (!id) {
        return reply.status(400).send({ message: "The 'id' query parameter is required" });
      }

      const cacheKey = getCacheKey('watch', { episodeId, id, provider });

      await fetchAndCache(fastify, cacheKey, () => {
        const tmdb = createTMDB(provider);
        return tmdb.fetchEpisodeSources(episodeId, id);
      }, reply);
    }
  );
};

export default routes;
