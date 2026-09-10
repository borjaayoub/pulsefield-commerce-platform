import { PrismaService } from './prisma.service';

describe('PrismaService', () => {
  it('disconnects the Prisma client when its Nest module is destroyed', async () => {
    // Arrange
    const prisma = new PrismaService('postgresql://pulsefield:password@localhost:5432/pulsefield');
    const disconnect = jest.spyOn(prisma, '$disconnect').mockResolvedValue(undefined);

    // Act
    await prisma.onModuleDestroy();

    // Assert
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
