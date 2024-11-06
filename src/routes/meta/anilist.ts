import { Redis } from 'ioredis';
import { FastifyRequest, FastifyReply, FastifyInstance, RegisterOptions } from 'fastify';
import { ANIME, META, PROVIDERS_LIST } from '@consumet/extensions';
import { Genres, StreamingServers } from '@consumet/extensions/dist/models';
import Anilist from '@consumet/extensions/dist/providers/meta/anilist';
import cache from '../../utils/cache';
import { redis } from '../../main';
import NineAnime from '@consumet/extensions/dist/providers/anime/9anime';
import Gogoanime from '@consumet/extensions/dist/providers/anime/gogoanime';

const routes = async (fastify: FastifyInstance, options: RegisterOptions) => {
  // Keep existing route handlers but modify these key endpoints:

  // Modified episodes endpoint with better error handling and caching
  fastify.get('/episodes/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const today = new Date();
    const dayOfWeek = today.getDay();
    const id = (request.params as { id: string }).id;
    const provider = (request.query as { provider?: string }).provider;
    let fetchFiller = (request.query as { fetchFiller?: string | boolean }).fetchFiller;
    let dub = (request.query as { dub?: string | boolean }).dub;

    // Convert string parameters to boolean
    const isDub = dub === 'true' || dub === '1';
    const shouldFetchFiller = fetchFiller === 'true' || fetchFiller === '1';

    let anilist = generateAnilistMeta(provider);

    try {
      const cacheKey = `anilist:episodes;${id};${isDub};${shouldFetchFiller};${anilist.provider.name.toLowerCase()}`;
      const cacheDuration = dayOfWeek === 0 || dayOfWeek === 6 ? 60 * 120 : (60 * 60) / 2;

      const fetchEpisodes = async () => {
        const episodes = await anilist.fetchEpisodesListById(id, isDub, shouldFetchFiller);
        if (!episodes || episodes.length === 0) {
          throw new Error('No episodes found');
        }
        return episodes;
      };

      if (redis) {
        const cachedData = await cache.fetch(redis, cacheKey, fetchEpisodes, cacheDuration);
        reply.status(200).send(cachedData);
      } else {
        const episodes = await fetchEpisodes();
        reply.status(200).send(episodes);
      }
    } catch (err) {
      console.error(`Error fetching episodes for ID ${id}:`, err);
      reply.status(404).send({ 
        message: 'Episodes not found',
        error: err instanceof Error ? err.message : 'Unknown error'
      });
    }
  });

  // Modified info endpoint with enhanced error handling
  fastify.get('/info/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const id = (request.params as { id: string }).id;
    const today = new Date();
    const dayOfWeek = today.getDay();
    const provider = (request.query as { provider?: string }).provider;
    let fetchFiller = (request.query as { fetchFiller?: string | boolean }).fetchFiller;
    let isDub = (request.query as { dub?: string | boolean }).dub;

    // Convert string parameters to boolean
    const shouldDub = isDub === 'true' || isDub === '1';
    const shouldFetchFiller = fetchFiller === 'true' || fetchFiller === '1';

    let anilist = generateAnilistMeta(provider);

    try {
      const cacheKey = `anilist:info;${id};${shouldDub};${shouldFetchFiller};${anilist.provider.name.toLowerCase()}`;
      const cacheDuration = dayOfWeek === 0 || dayOfWeek === 6 ? 60 * 120 : (60 * 60) / 2;

      const fetchInfo = async () => {
        const info = await anilist.fetchAnimeInfo(id, shouldDub, shouldFetchFiller);
        if (!info) {
          throw new Error('Anime info not found');
        }
        return info;
      };

      if (redis) {
        const cachedData = await cache.fetch(redis, cacheKey, fetchInfo, cacheDuration);
        reply.status(200).send(cachedData);
      } else {
        const info = await fetchInfo();
        reply.status(200).send(info);
      }
    } catch (err) {
      console.error(`Error fetching anime info for ID ${id}:`, err);
      reply.status(500).send({ 
        message: 'Failed to fetch anime info',
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

// Enhanced provider generation with better error handling
const generateAnilistMeta = (provider: string | undefined = undefined): Anilist => {
  try {
    if (provider) {
      let possibleProvider = PROVIDERS_LIST.ANIME.find(
        (p) => p.name.toLowerCase() === provider.toLowerCase()
      );

      if (possibleProvider instanceof NineAnime) {
        if (!process.env?.NINE_ANIME_HELPER_URL || !process.env?.NINE_ANIME_HELPER_KEY) {
          throw new Error('9Anime configuration is missing');
        }

        possibleProvider = new ANIME.NineAnime(
          process.env.NINE_ANIME_HELPER_URL,
          { url: process.env?.NINE_ANIME_PROXY as string },
          process.env.NINE_ANIME_HELPER_KEY
        );
      }

      return new META.Anilist(possibleProvider, {
        url: process.env.PROXY as string | string[],
      });
    }

    // Default to Gogoanime provider
    return new Anilist(new Gogoanime(), {
      url: process.env.PROXY as string | string[],
    });
  } catch (err) {
    console.error('Error generating Anilist provider:', err);
    // Fallback to default Gogoanime provider
    return new Anilist(new Gogoanime(), {
      url: process.env.PROXY as string | string[],
    });
  }
};

export default routes;
