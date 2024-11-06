import { Redis } from 'ioredis';
import { FastifyRequest, FastifyReply, FastifyInstance, RegisterOptions } from 'fastify';
import { ANIME, META, PROVIDERS_LIST } from '@consumet/extensions';
import { Genres, StreamingServers } from '@consumet/extensions/dist/models';
import Anilist from '@consumet/extensions/dist/providers/meta/anilist';
import cache from '../../utils/cache';
import { redis } from '../../main';
import NineAnime from '@consumet/extensions/dist/providers/anime/9anime';
import Gogoanime from '@consumet/extensions/dist/providers/anime/gogoanime';
import Zoro from '@consumet/extensions/dist/providers/anime/zoro';
import Crunchyroll from '@consumet/extensions/dist/providers/anime/crunchyroll';

const routes = async (fastify: FastifyInstance, options: RegisterOptions) => {
  fastify.get('/', (_, rp) => {
    rp.status(200).send({
      intro: "Welcome to the anilist provider: check out the provider's website @ https://anilist.co/",
      routes: ['/:query', '/info/:id', '/watch/:episodeId'],
      documentation: 'https://docs.consumet.org/#tag/anilist',
    });
  });

  fastify.get('/:query', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = (request.params as { query: string }).query;
    const page = (request.query as { page: number }).page;
    const perPage = (request.query as { perPage: number }).perPage;

    try {
      const anilist = generateAnilistMeta();
      const res = await anilist.search(query, page, perPage);
      reply.status(200).send(res);
    } catch (err) {
      reply.status(400).send({ message: (err as Error).message });
    }
  });

  fastify.get('/advanced-search', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const query = (request.query as { query: string }).query;
      const page = (request.query as { page: number }).page;
      const perPage = (request.query as { perPage: number }).perPage;
      const type = (request.query as { type: string }).type;
      let genres = (request.query as { genres: string | string[] }).genres;
      const id = (request.query as { id: string }).id;
      const format = (request.query as { format: string }).format;
      let sort = (request.query as { sort: string | string[] }).sort;
      const status = (request.query as { status: string }).status;
      const year = (request.query as { year: number }).year;
      const season = (request.query as { season: string }).season;

      const anilist = generateAnilistMeta();

      if (genres) {
        genres = JSON.parse(genres as string);
        for (const genre of genres as string[]) {
          if (!Object.values(Genres).includes(genre as Genres)) {
            return reply.status(400).send({ message: `${genre} is not a valid genre` });
          }
        }
      }

      if (sort) sort = JSON.parse(sort as string);

      if (season && !['WINTER', 'SPRING', 'SUMMER', 'FALL'].includes(season)) {
        return reply.status(400).send({ message: `${season} is not a valid season` });
      }

      const res = await anilist.advancedSearch(
        query,
        type,
        page,
        perPage,
        format,
        sort as string[],
        genres as string[],
        id,
        year,
        status,
        season,
      );

      reply.status(200).send(res);
    } catch (err) {
      reply.status(400).send({ message: (err as Error).message });
    }
  });

  fastify.get('/info/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const id = (request.params as { id: string }).id;
    const provider = (request.query as { provider?: string }).provider;
    let fetchFiller = (request.query as { fetchFiller?: string | boolean }).fetchFiller;
    let isDub = (request.query as { dub?: string | boolean }).dub;

    if (!id) {
      return reply.status(400).send({ message: 'ID is required' });
    }

    const shouldDub = isDub === 'true' || isDub === '1';
    const shouldFetchFiller = fetchFiller === 'true' || fetchFiller === '1';

    try {
      let anilist: Anilist;

      if (provider) {
        const selectedProvider = getAnimeProvider(provider);
        if (!selectedProvider) {
          return reply.status(400).send({ message: `Invalid provider: ${provider}` });
        }
        anilist = new META.Anilist(selectedProvider, { url: process.env.PROXY as string | string[] });
      } else {
        anilist = new META.Anilist(new Gogoanime(), { url: process.env.PROXY as string | string[] });
      }

      const cacheKey = `anilist:info:${id}:${shouldDub}:${shouldFetchFiller}:${provider || 'gogoanime'}`;

      const fetchInfo = async () => {
        try {
          const info = await anilist.fetchAnimeInfo(id, shouldDub, shouldFetchFiller);
          if (!info) throw new Error('Anime not found');
          return info;
        } catch (error) {
          console.error('Error fetching anime info:', error);
          throw error;
        }
      };

      let result;
      if (redis) {
        result = await cache.fetch(redis, cacheKey, fetchInfo, 60 * 60);
      } else {
        result = await fetchInfo();
      }

      reply.status(200).send(result);
    } catch (err) {
      console.error(`Error fetching anime info for ID ${id}:`, err);
      reply.status(500).send({
        message: 'Failed to fetch anime info',
        error: err instanceof Error ? err.message : 'Unknown error'
      });
    }
  });

   fastify.get('/watch/:episodeId', async (request: FastifyRequest, reply: FastifyReply) => {
    const episodeId = (request.params as { episodeId: string }).episodeId;
    const provider = (request.query as { provider?: string }).provider;
    const server = (request.query as { server?: StreamingServers }).server;

    try {
      if (!episodeId) {
        throw new Error('Episode ID is required');
      }

      if (server && !Object.values(StreamingServers).includes(server)) {
        throw new Error('Invalid streaming server');
      }

      const anilist = generateAnilistMeta(provider);
      const cacheKey = `anilist:watch:${episodeId}:${provider || 'gogoanime'}:${server || 'default'}`;

      const fetchSources = async () => {
        const sources = await anilist.fetchEpisodeSources(episodeId, server);
        if (!sources) throw new Error('No sources found');
        return sources;
      };

      let result;
      if (redis) {
        result = await cache.fetch(redis, cacheKey, fetchSources, 600); // 10 minutes cache
      } else {
        result = await fetchSources();
      }

      reply.status(200).send(result);
    } catch (err) {
      reply.status(500).send({
        message: 'Failed to fetch episode sources',
        error: err instanceof Error ? err.message : 'Unknown error'
      });
    }
  });

  // Modified watch endpoint with better error handling and source validation
  fastify.get('/watch/:episodeId', async (request: FastifyRequest, reply: FastifyReply) => {
    const episodeId = (request.params as { episodeId: string }).episodeId;
    const provider = (request.query as { provider?: string }).provider;
    const server = (request.query as { server?: StreamingServers }).server;

    if (!episodeId) {
      return reply.status(400).send({ message: 'Episode ID is required' });
    }

    if (server && !Object.values(StreamingServers).includes(server)) {
      return reply.status(400).send({ message: 'Invalid streaming server' });
    }

    let anilist = generateAnilistMeta(provider);

    try {
      const cacheKey = `anilist:watch;${episodeId};${anilist.provider.name.toLowerCase()};${server}`;
      
      const fetchSources = async () => {
        const sources = await anilist.fetchEpisodeSources(episodeId, server);
        if (!sources || (!sources.sources?.length && !sources.download)) {
          throw new Error('No sources found');
        }
        return sources;
      };

      if (redis) {
        const cachedData = await cache.fetch(redis, cacheKey, fetchSources, 600);
        reply.status(200).send(cachedData);
      } else {
        const sources = await fetchSources();
        reply.status(200).send(sources);
      }
    } catch (err) {
      console.error(`Error fetching sources for episode ${episodeId}:`, err);
      reply.status(500).send({ 
        message: 'Failed to fetch episode sources',
        error: err instanceof Error ? err.message : 'Unknown error'
      });
    }
  });
}

const getAnimeProvider = (providerName: string) => {
  const providers: { [key: string]: any } = {
    'gogoanime': Gogoanime,
    'zoro': Zoro,
    '9anime': NineAnime,
    'crunchyroll': Crunchyroll
  };

  const Provider = providers[providerName.toLowerCase()];
  if (!Provider) return null;

  if (Provider === NineAnime) {
    return new Provider(
      process.env?.NINE_ANIME_HELPER_URL,
      { url: process.env?.NINE_ANIME_PROXY as string },
      process.env?.NINE_ANIME_HELPER_KEY
    );
  }

  return new Provider();
};

const generateAnilistMeta = (provider: string | undefined = undefined): Anilist => {
  try {
    if (provider) {
      const possibleProvider = getAnimeProvider(provider);
      if (possibleProvider) {
        return new META.Anilist(possibleProvider, {
          url: process.env.PROXY as string | string[]
        });
      }
    }

    return new META.Anilist(new Gogoanime(), {
      url: process.env.PROXY as string | string[]
    });
  } catch (err) {
    console.error('Error generating Anilist provider:', err);
    return new META.Anilist(new Gogoanime(), {
      url: process.env.PROXY as string | string[]
    });
  }
};

export default routes;
