import { FastifyRequest, FastifyReply, FastifyInstance, RegisterOptions } from 'fastify';
import { MOVIES } from '@consumet/extensions';
import { StreamingServers } from '@consumet/extensions/dist/models';

const routes = async (fastify: FastifyInstance, options: RegisterOptions) => {
  const dramacool = new MOVIES.DramaCool();

  fastify.get('/', (_, rp) => {
    rp.status(200).send({
      intro: "Welcome to the dramacool provider: check out the provider's website @ https://dramacool.com.pa/",
      routes: ['/:query', '/info', '/watch', '/popular','/recent-movies', '/recent-shows'],
      documentation: 'https://docs.consumet.org/#tag/dramacool',
    });
  });

  fastify.get('/recent-movies', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const page = (request.query as { page: number }).page;

      const results = await dramacool.fetchRecentMovies(page ? page : 1);

      reply.status(200).send(results);
    } catch (err) {
      reply
        .status(500)
        .send({ message: 'Something went wrong. Please try again later.' });
    }
  });

  fastify.get('/recent-shows', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const page = (request.query as { page: number }).page;

      const results = await dramacool.fetchRecentTvShows(page ? page : 1);

      reply.status(200).send(results);
    } catch (err) {
      reply
        .status(500)
        .send({ message: 'Something went wrong. Please try again later.' });
    }
  });

  fastify.get('/popular', async (request: FastifyRequest, reply: FastifyReply) => {
    const page = (request.query as { page: number }).page;
    try {
      const res = await dramacool.fetchPopular(page ? page : 1);
      reply.status(200).send(res);
    } catch (err) {
      reply
        .status(500)
        .send({ message: 'Something went wrong. Please try again later.' });
    }
  });

  fastify.get('/:query', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const query = decodeURIComponent((request.params as { query: string }).query);
      const page = (request.query as { page: number }).page;

      const res = await dramacool.search(query, page);

      reply.status(200).send(res);
    } catch (err) {
      reply.status(500).send({
        message: 'Something went wrong. Please try again later or contact the developers.',
      });
    }
  });

  fastify.get('/info', async (request: FastifyRequest, reply: FastifyReply) => {
    const id = (request.query as { id: string }).id;

    if (typeof id === 'undefined')
      return reply.status(400).send({
        message: 'id is required',
      });

    try {
      const res = await dramacool
        .fetchMediaInfo(id)
        .catch((err) => reply.status(404).send({ message: err }));

      reply.status(200).send(res);
    } catch (err) {
      reply.status(500).send({
        message: 'Something went wrong. Please try again later or contact the developers.',
      });
    }
  });

  fastify.get('/watch', async (request: FastifyRequest, reply: FastifyReply) => {
    const episodeId = (request.query as { episodeId: string }).episodeId;
    const mediaId = (request.query as { mediaId: string }).mediaId;
    const serverString = (request.query as { server: string }).server;

    if (typeof episodeId === 'undefined')
      return reply.status(400).send({ message: 'episodeId is required' });

    try {
      // Convert server string to StreamingServers enum
      let server: StreamingServers | undefined = undefined;
      if (serverString) {
        switch (serverString.toLowerCase()) {
          case 'asianload':
            server = StreamingServers.AsianLoad;
            break;
          case 'mixdrop':
            server = StreamingServers.MixDrop;
            break;
          case 'streamtape':
            server = StreamingServers.StreamTape;
            break;
          case 'streamsb':
            server = StreamingServers.StreamSB;
            break;
          default:
            reply.status(400).send({ message: 'Invalid server specified' });
            return;
        }
      }

      const res = await dramacool
        .fetchEpisodeSources(episodeId, server)
        .catch((err) => reply.status(404).send({ message: err }));

      reply.status(200).send(res);
    } catch (err) {
      reply
        .status(500)
        .send({ message: 'Something went wrong. Please try again later.' });
    }
  });

  fastify.get("/servers", async (request: FastifyRequest, reply: FastifyReply) => {
    const episodeId = (request.query as { episodeId: string }).episodeId;

    if (typeof episodeId === 'undefined')
      return reply.status(400).send({ message: 'episodeId is required' });

    try {
      const res = await dramacool
        .fetchEpisodeServers(episodeId)
        .catch((err) => reply.status(404).send({ message: err }));

      reply.status(200).send(res);
    } catch (err) {
      reply
        .status(500)
        .send({ message: 'Something went wrong. Please try again later.' });
    }
  });
};

export default routes;
